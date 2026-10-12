import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/ui";
import { extOf, downloadVersion } from "../../api/files";
import { errorText } from "../../api/errors";
import { makeFull, type Full, type Thumb } from "./preview";
import type { Item } from "./useAttachments";
import type { AttachmentContext } from "../../api/agent";
import type { ExtractionCoverage } from "../../api/files";
import type { AttachmentMeta } from "../store/ChatStore";

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
            {(it.status === "uploading" || it.status === "processing") && <span className="thumb-busy" aria-label="Загружается"><span className="spinner" /></span>}
            {it.status === "error" && <span className="thumb-state bad" title={it.error}>Ошибка</span>}
          </button>
          <span className="name" title={it.error ?? it.file.name}>{it.status === "error" ? it.error : it.file.name}</span>
          {it.meta?.extraction && <small className="attach-hint">{it.meta.extraction.extraction_state === "partial" ? "Частично извлечён" : "Текст извлечён"}. {coverageText(it.meta.extraction.coverage)}{it.meta.extraction.warnings.length ? ` · ${it.meta.extraction.warnings.map(warningText).join("; ")}` : ""}</small>}
          {it.status === "error" && <button type="button" className="thumb-retry" onClick={() => onRetry(it.id)}><Icon name="refresh" />Повторить</button>}
          <button type="button" className="remove" aria-label={`Убрать ${it.file.name}`} onClick={() => onRemove(it.id)}><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}

// Вложения истории: расширение; защищённая версия скачивается при открытии.
export function MessageThumbs({ items, onOpen }: { items: AttachmentMeta[]; onOpen: (a: AttachmentMeta) => void }) {
  return (
    <div className="thumbs">
      {items.map((a) => (
        <div key={a.version_id} className="thumb">
          <button type="button" className="pic" onClick={() => onOpen(a)} title={a.filename}>
            <Pic thumb={{ kind: "ext", ext: extOf(a.filename).replace(".", "") }} />
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
  const [page, setPage] = useState(1);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => setPage(1), [target]);
  useEffect(() => {
    const ac = new AbortController();
    setFull(null); setErr(null);
    (async () => {
      try {
        const b = target.meta ? await downloadVersion(target.meta.file_id, target.meta.version_id, ac.signal) : target.file;
        if (!b) throw new Error("Файл недоступен");
        const f = await makeFull(b, target.name, page);
        if (!ac.signal.aborted) setFull(f);
      } catch (e) {
        if (!ac.signal.aborted) setErr(errorText(e));
      }
    })();
    const recheck = () => { ac.abort(); setFull(null); close.current(); };
    if (target.meta) window.addEventListener("blur", recheck);
    return () => { ac.abort(); window.removeEventListener("blur", recheck); };
  }, [target, page]);

  // Окно только показывает документ: название, крестик и сам документ во всю ширину
  return (
    <Modal onClose={onClose} label={target.name}>
      <div className="viewer">
        <div className="viewer-head">
          <span>{target.name}</span>
          {full?.kind === "pdf" && <div className="table-tools"><button className="btn sm soft" disabled={page <= 1} onClick={() => setPage(page - 1)}>Назад</button><span>Страница {page} из {full.totalPages}</span><button className="btn sm soft" disabled={page >= full.totalPages} onClick={() => setPage(page + 1)}>Далее</button></div>}
          <button className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className={`viewer-body${!full && !err ? " loading" : ""}`}>
          {err ? <p className="form-error">{err}</p>
            : !full ? <span className="spinner" aria-label="Загружается" />
            : full.kind === "pdf" ? full.pages.map((c, i) => <CanvasView key={i} canvas={c} />)
            : full.kind === "html" ? <div className="doc html" dangerouslySetInnerHTML={{ __html: full.html }} />
            : full.kind === "text" ? <div className="doc">{full.text}</div>
            : <p>Просмотр этого формата не поддерживается</p>}
        </div>
      </div>
    </Modal>
  );
}

export function coverageText(c: ExtractionCoverage | null | undefined): string {
  if (!c) return "Полнота извлечения пока неизвестна";
  if (c.total_pages != null) return `Страниц: ${c.attempted_pages ?? 0} из ${c.total_pages}; с ошибкой: ${c.failed_pages ?? 0}; не обработано: ${c.unprocessed_pages ?? 0}`;
  return `Фрагментов: ${c.total_chunks ?? 0}; обработано частей: ${c.processed_batches ?? 0} из ${c.total_batches ?? 0}${c.complete ? "" : "; извлечение неполное"}`;
}
const WARNINGS: Record<string, string> = {
  context_truncated: "В контекст вошла часть файла", page_text_truncated: "Текст страницы ограничен", ocr_unavailable: "Распознавание недоступно",
  low_quality: "Низкое качество распознавания", stopped: "Обработка остановлена", parser_resource_limit: "Достигнут предел обработки",
  context_budget_exhausted: "Достигнут предел контекста ответа", history_truncated: "История в контексте сокращена",
  unverified_citation: "Ссылка на фрагмент не подтверждена", no_readable_text: "Читаемый текст не найден",
};
export const warningText = (value: string) => WARNINGS[value] ?? value;
const LIMITS: Record<string, string> = { initial_text_chars: "символов в начале", read_text_chars: "символов за чтение", run_text_chars: "символов за ответ", max_text_chunks: "фрагментов" };

export function ContextDetails({ context }: { context?: AttachmentContext }) {
  if (!context?.files.length) return null;
  return <details className="attach-hint"><summary>Вложения в ответе: {context.files.length}</summary>{context.files.map((file) => <div key={file.version_id}>
    <b>{file.filename}</b><p>{file.extraction_state === "partial" ? "Частично извлечён" : file.extraction_state === "ready" ? "Текст извлечён" : "Извлечение не завершено"}. {coverageText(file.extraction_coverage)}</p>
    <p>{file.context_state === "used" ? "В ответе есть подтверждённые ссылки на фрагменты" : file.context_state === "provided" ? "Фрагменты предоставлены в контекст" : file.context_state === "not_used" ? "Подтверждённых ссылок на фрагменты нет" : "Контекст ещё готовится"}. Формат: {file.read_mode === "text" ? "текст" : file.read_mode === "vision" ? "изображение" : file.read_mode === "text_and_vision" ? "текст и изображение" : "не передан"}.</p>
    <p>Предоставлено фрагментов: {file.provided_chunk_ids?.length ?? 0}; запрошено чтением: {file.read_chunk_ids?.length ?? 0}; процитировано: {file.cited_chunk_ids?.length ?? 0}.</p>
    <p>{file.delivery_state === "acknowledged" ? "Провайдер подтвердил получение контекста" : file.delivery_state === "submitted" ? "Контекст отправлен, подтверждения ещё нет" : file.delivery_state === "unknown" ? "Доставка контекста не подтверждена" : "Контекст пока не отправлен"}.</p>
    {!!file.provided_pages?.length && <p>Предоставлены страницы: {file.provided_pages.join(", ")}</p>}{!!file.cited_pages?.length && <p>Цитируются страницы: {file.cited_pages.join(", ")}</p>}
    {Object.entries(file.limits ?? {}).some(([key, value]) => LIMITS[key] && typeof value === "number") && <p>Ограничения контекста: {Object.entries(file.limits).filter(([key, value]) => LIMITS[key] && typeof value === "number").map(([key, value]) => `${LIMITS[key]} — ${value}`).join("; ")}</p>}
    {(file.coverage?.truncated || !!file.warnings?.length) && <p className="form-error">{[...new Set([...(file.warnings ?? []), ...(file.coverage?.truncated ? ["context_truncated"] : [])])].map(warningText).join("; ")}</p>}
  </div>)}</details>;
}

function CanvasView({ canvas }: { canvas: HTMLCanvasElement }) {
  return <div className="canvas-host" ref={(el) => { if (el && !el.contains(canvas)) { el.innerHTML = ""; el.append(canvas); } }} />;
}
