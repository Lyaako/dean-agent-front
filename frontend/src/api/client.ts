// Обращения к API бэкенда (docs/INTEGRATION.md): Bearer-токен в памяти, обновление по cookie + CSRF.
// Обновление строго одно на всех: повторное использование старой cookie отзывает всю сессию.

export const API_BASE = "/api/v1";
const CSRF_KEY = "deanery.csrf";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onExpired: (() => void) | null = null;

export const session = {
  start(access: string, csrf: string) {
    accessToken = access;
    // CSRF-токен выдаётся только при входе; в sessionStorage — чтобы перезагрузка страницы не выкидывала на логин
    try { sessionStorage.setItem(CSRF_KEY, csrf); } catch { /* приватный режим — останется только в памяти */ }
  },
  clear() {
    accessToken = null;
    try { sessionStorage.removeItem(CSRF_KEY); } catch { /* нет доступа к хранилищу */ }
  },
  hasCsrf() {
    try { return !!sessionStorage.getItem(CSRF_KEY); } catch { return false; }
  },
  onExpired(fn: () => void) { onExpired = fn; },
};

export async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`, message = res.statusText, details: unknown, requestId = res.headers.get("X-Request-ID") ?? undefined;
  try {
    const body = await res.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
      requestId = body.request_id ?? requestId;
    }
  } catch { /* тело не JSON */ }
  return new ApiError(res.status, code, message, requestId, details);
}

export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    let csrf: string | null = null;
    try { csrf = sessionStorage.getItem(CSRF_KEY); } catch { /* нет доступа */ }
    if (!csrf) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}",
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) session.clear();
        return false;
      }
      accessToken = (await res.json()).access_token;
      return true;
    } catch {
      return false;
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Query) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.append(k, String(v));
  const s = qs.toString();
  return `${API_BASE}${path}${s ? `?${s}` : ""}`;
}

// Возвращает сам Response (для потоков и файлов); на 401 один раз обновляет токен и повторяет запрос
export async function apiRaw(path: string, opts: RequestOptions = {}, retried = false): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? (opts.json !== undefined || opts.body ? "POST" : "GET"),
    headers, credentials: "include", signal: opts.signal,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  if (res.status === 401 && !retried && !path.startsWith("/auth/login")) {
    if (await refreshSession()) return apiRaw(path, opts, true);
    session.clear();
    onExpired?.();
  }
  if (!res.ok) throw await readError(res);
  return res;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const newKey = () => crypto.randomUUID();
