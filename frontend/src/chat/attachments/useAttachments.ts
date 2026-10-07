import { useCallback, useEffect, useRef, useState } from "react";
import { ATTACH_TYPES, MAX_FILE_BYTES, extOf, uploadFile, waitJob } from "../../api/files";
import { errorText } from "../../api/errors";
import { newKey } from "../../api/client";
import { makeThumb, type Thumb } from "./preview";
import type { AttachmentMeta } from "../store/ChatStore";

export type ItemStatus = "uploading" | "processing" | "ready" | "error";

export interface Item {
  id: string;
  file: File;
  thumb: Thumb | null;
  status: ItemStatus;
  error?: string;
  meta?: AttachmentMeta;
}

// Превью, сделанные в этой вкладке браузера, — чтобы в истории чата показывать их, а не только расширение
export const thumbCache = new Map<string, Thumb>();
export const fileCache = new Map<string, File>();

interface Limits { maxCount: number; maxTotal: number }

// Вложение загружается сразу при прикреплении: POST /files → ждём job → файл готов к отправке агенту
export function useAttachments(limits: Limits) {
  const [items, setItems] = useState<Item[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const patch = (id: string, p: Partial<Item>) => setItems((l) => l.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const upload = useCallback(async (item: Item) => {
    const ac = new AbortController();
    aborts.current.set(item.id, ac);
    patch(item.id, { status: "uploading", error: undefined });
    try {
      const up = await uploadFile(item.file, newKey(), ac.signal);
      patch(item.id, { status: "processing" });
      const job = up.job.status === "succeeded" ? up.job : await waitJob(up.job.id, ac.signal);
      if (job.status !== "succeeded") throw new Error(job.error_code === "infected" ? "Файл не прошёл антивирусную проверку" : "Файл не удалось обработать");
      const meta: AttachmentMeta = { file_id: up.file_id, version_id: up.version_id, title: item.file.name, filename: item.file.name, mime: item.file.type, size: item.file.size };
      fileCache.set(up.version_id, item.file);
      patch(item.id, { status: "ready", meta });
    } catch (e) {
      if (ac.signal.aborted) return;
      patch(item.id, { status: "error", error: errorText(e) });
    } finally {
      aborts.current.delete(item.id);
    }
  }, []);

  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;

  const add = useCallback((files: FileList | File[]) => {
    const errors: string[] = [];
    const accepted: Item[] = [];
    let count = itemsRef.current.length;
    let total = itemsRef.current.reduce((s, x) => s + x.file.size, 0);
    for (const file of [...files]) {
      if (!ATTACH_TYPES.includes(extOf(file.name))) { errors.push(`«${file.name}»: можно только ${ATTACH_TYPES.join(", ")}`); continue; }
      if (file.size > MAX_FILE_BYTES) { errors.push(`«${file.name}» больше 10 МБ`); continue; }
      if (count >= limits.maxCount) { errors.push(`Не больше ${limits.maxCount} файлов в одном сообщении`); break; }
      if (total + file.size > limits.maxTotal) { errors.push(`Вместе файлы больше ${Math.round(limits.maxTotal / 1e6)} МБ`); break; }
      count += 1;
      total += file.size;
      accepted.push({ id: newKey(), file, thumb: null, status: "uploading" });
    }
    if (accepted.length) setItems((l) => [...l, ...accepted]);
    setNotice(errors.length ? errors.join(". ") : null);
    for (const item of accepted) {
      upload(item);
      makeThumb(item.file, item.file.name).then((thumb) => patch(item.id, { thumb }));
    }
  }, [limits.maxCount, limits.maxTotal, upload]);

  const remove = useCallback((id: string) => {
    aborts.current.get(id)?.abort();
    setItems((l) => l.filter((x) => x.id !== id));
  }, []);

  const retry = useCallback((id: string) => {
    const it = itemsRef.current.find((x) => x.id === id);
    if (it) upload(it);
  }, [upload]);

  // Забрать готовые вложения для отправки и очистить поле
  const take = useCallback(() => {
    const ready = items.filter((x) => x.status === "ready" && x.meta);
    for (const x of ready) if (x.thumb) thumbCache.set(x.meta!.version_id, x.thumb);
    setItems([]);
    setNotice(null);
    return ready.map((x) => x.meta!);
  }, [items]);

  useEffect(() => () => { for (const ac of aborts.current.values()) ac.abort(); }, []);

  return {
    items, add, remove, retry, take, notice, clearNotice: () => setNotice(null),
    pending: items.some((x) => x.status === "uploading" || x.status === "processing"),
    hasErrors: items.some((x) => x.status === "error"),
  };
}
