import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/ui";
import { extOf, downloadVersion } from "../../api/files";
import { errorText } from "../../api/errors";
import { makeFull, type Full, type Thumb } from "./preview";
import { fileCache, thumbCache, type Item } from "./useAttachments";
import type { AttachmentMeta } from "../store/ChatStore";

const STATUS: Record<string, string> = { uploading: "Загрузка…", processing: "Проверка…" };

function Pic({ thumb, loading }: { thumb: Thumb | null | undefined; loading?: boolean }) {
  if (!thumb) return <span className={`pic-inner${loading ? "" : " ext"}`}>{loading ? "" : "файл"}</span>;
  if (thumb.kind === "img") return <img src={thumb.src} alt="" />;
  if (thumb.kind === "text") return <div className="page">{thumb.text}</div>;
  return <div className="ext">{thumb.ext}</div>;
}

// Вложения в поле ввода: со статусом загрузки, удалением и повтором
export function ComposerThumbs({ items, onRemove, onRetry, onOpen }: {
  items: Item[]; onRemove: (id: string) => void; onRetry: (id: string) => void; onOpen: (file: File) => void;
}) {
  return (
    <div className="thumbs">
      {items.map((it) => (
        <div key={it.id} className={`thumb st-${it.status}`}>
          <button type="button" className={`pic${!it.thumb ? " loading" : ""}`} onClick={() => onOpen(it.file)} title={it.file.name}>
            <Pic thumb={it.thumb} loading={!it.thumb} />
            {STATUS[it.status] && <span className="thumb-state"><span className="spinner sm" />{STATUS[it.status]}</span>}
            {it.status === "error" && <span className="thumb-state bad" title={it.error}>Ошибка</span>}
          </button>
          <span className="name" title={it.error ?? it.file.name}>{it.status === "error" ? it.error : it.file.name}</span>
          {it.status === "error" && <button type="button" className="thumb-retry" onClick={() => onRetry(it.id)}><Icon name="refresh" />Повторить</button>}
          <button type="button" className="remove" aria-label={`Убрать ${it.file.name}`} onClick={() => onRemove(it.id)}><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}

// Вложения в сообщении: превью из этой сессии или расширение; клик — просмотр (файл скачивается с сервера)
export function MessageThumbs({ items, onOpen }: { items: AttachmentMeta[]; onOpen: (a: AttachmentMeta) => void }) {
  return (
    <div className="thumbs">
      {items.map((a) => (
        <div key={a.version_id} className="thumb">
          <button type="button" className="pic" onClick={() => onOpen(a)} title={a.filename}>
            <Pic thumb={thumbCache.get(a.version_id) ?? { kind: "ext", ext: extOf(a.filename).replace(".", "") }} />
          </button>
          <span className="name">{a.filename}</span>
        </div>
      ))}
    </div>
  );
}

export type ViewTarget = { name: string; file?: File; meta?: AttachmentMeta };

export function FileViewer({ target, onClose }: { target: ViewTarget; onClose: () => void }) {
  const [full, setFull] = useState<Full | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = target.file ?? (target.meta && fileCache.get(target.meta.version_id)) ?? (target.meta ? await downloadVersion(target.meta.file_id, target.meta.version_id) : null);
        if (!b) throw new Error("Файл недоступен");
        if (!alive) return;
        setBlob(b);
        const f = await makeFull(b, target.name);
        if (alive) setFull(f);
      } catch (e) {
        if (alive) setErr(errorText(e));
      }
    })();
    return () => { alive = false; };
  }, [target]);

  const save = () => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: target.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Modal onClose={onClose} label={target.name}>
      <div className="viewer">
        <div className="viewer-head">
          <span>{target.name}</span>
          {blob && <button className="btn sm ghost" onClick={save}>Скачать</button>}
          <button className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="viewer-body">
          {err ? <p className="form-error">{err}</p>
            : !full ? <div className="spinner" />
            : full.kind === "pdf" ? full.pages.map((c, i) => <CanvasView key={i} canvas={c} />)
            : full.kind === "html" ? <div className="doc html" dangerouslySetInnerHTML={{ __html: full.html }} />
            : full.kind === "text" ? <div className="doc">{full.text}</div>
            : <p>Просмотр этого формата не поддерживается</p>}
        </div>
      </div>
    </Modal>
  );
}

function CanvasView({ canvas }: { canvas: HTMLCanvasElement }) {
  return <div className="canvas-host" ref={(el) => { if (el && !el.contains(canvas)) { el.innerHTML = ""; el.append(canvas); } }} />;
}
