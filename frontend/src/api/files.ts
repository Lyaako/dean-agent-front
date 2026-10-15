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

export interface ExtractionCoverage {
  total_pages?: number | null; attempted_pages?: number | null; text_pages?: number; ocr_pages?: number;
  failed_pages?: number; unprocessed_pages?: number; low_quality_pages?: number; truncated_pages?: number;
  total_chunks?: number; processed_batches?: number; total_batches?: number; complete?: boolean; truncated?: boolean;
}
export interface ExtractionResult {
  file_id: string; version_id: string; title?: string; filename?: string; mime?: string; byte_size?: number;
  extraction_state: string; coverage: ExtractionCoverage | null; warnings: string[];
  pages?: { page?: number; block?: number; state: string; quality?: string; warnings?: string[]; chunk_count?: number }[];
  page_offset?: number; page_limit?: number; has_more_pages?: boolean;
}

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  progress: number;
  result: ExtractionResult | null;
  error_code: string | null;
}
export interface Upload { file_id: string; version_id: string; job: Job }

export function uploadFile(file: File, idempotencyKey: string = newKey(), signal?: AbortSignal) {
  const typed = new File([file], file.name, { type: MIME[extOf(file.name)] ?? file.type });
  const form = new FormData();
  form.append("file", typed);
  form.append("title", file.name.slice(0, 255));
  form.append("purpose", "attachment");
  return api<Upload>("/files", { method: "POST", body: form, headers: { "Idempotency-Key": idempotencyKey }, signal });
}

export const getJob = (id: string, signal?: AbortSignal, pageOffset = 0) => api<Job>(`/jobs/${id}`, { query: { page_offset: pageOffset, page_limit: 100 }, signal });

// Ждём окончания обработки: опрос раз в секунду
export async function waitJob(id: string, signal?: AbortSignal, onTick?: (j: Job) => void): Promise<Job> {
  for (;;) {
    const j = await getJob(id, signal);
    onTick?.(j);
    if (j.status === "succeeded" || j.status === "failed") return j;
    signal?.throwIfAborted();
    await new Promise((r, rej) => {
      const abort = () => { clearTimeout(t); rej(new DOMException("Aborted", "AbortError")); };
      const t = setTimeout(() => { signal?.removeEventListener("abort", abort); r(undefined); }, 1000);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

export async function downloadVersion(fileId: string, versionId: string, signal?: AbortSignal): Promise<Blob> {
  const res = await apiRaw(`/files/${fileId}/versions/${versionId}/download`, { signal });
  return res.blob();
}
