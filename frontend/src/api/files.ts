// Файлы: загрузка (multipart + Idempotency-Key) → обработка в фоне (job) → скачивание после готовности
import { api, apiRaw, newKey } from "./client";

export const ATTACH_TYPES = [".pdf", ".docx", ".txt"];   // ровно то, что принимает POST /files
export const MAX_FILE_BYTES = 10_000_000;
// Тип должен точно соответствовать расширению — иначе бэкенд отклонит файл
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
};
export const extOf = (name: string) => (name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  progress: number;
  result: Record<string, unknown> | null;
  error_code: string | null;
}
export interface Upload { file_id: string; version_id: string; job: Job }

export function uploadFile(file: File, idempotencyKey = newKey(), signal?: AbortSignal) {
  const typed = new File([file], file.name, { type: MIME[extOf(file.name)] ?? file.type });
  const form = new FormData();
  form.append("file", typed);
  form.append("title", file.name.slice(0, 255));
  form.append("purpose", "attachment");
  return api<Upload>("/files", { method: "POST", body: form, headers: { "Idempotency-Key": idempotencyKey }, signal });
}

export const getJob = (id: string, signal?: AbortSignal) => api<Job>(`/jobs/${id}`, { signal });

// Ждём окончания обработки: опрос раз в секунду
export async function waitJob(id: string, signal?: AbortSignal, onTick?: (j: Job) => void): Promise<Job> {
  for (;;) {
    const j = await getJob(id, signal);
    onTick?.(j);
    if (j.status === "succeeded" || j.status === "failed") return j;
    await new Promise((r, rej) => {
      const t = setTimeout(r, 1000);
      signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
  }
}

export async function downloadVersion(fileId: string, versionId: string): Promise<Blob> {
  const res = await apiRaw(`/files/${fileId}/versions/${versionId}/download`);
  return res.blob();
}
