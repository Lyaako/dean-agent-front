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
let revision = 0;

export const session = {
  start(access: string, csrf: string) {
    revision++;
    refreshing = null;
    accessToken = access;
    // CSRF-токен выдаётся только при входе. Храним в localStorage: перезагрузка не выкидывает на логин,
    // и все вкладки работают в одной сессии (cookie обновления у них и так общая)
    try { localStorage.setItem(CSRF_KEY, csrf); } catch { /* приватный режим — останется только в памяти */ }
  },
  clear() {
    revision++;
    refreshing = null;
    accessToken = null;
    try { localStorage.removeItem(CSRF_KEY); } catch { /* нет доступа к хранилищу */ }
  },
  hasAccess() { return !!accessToken; },
  revision() { return revision; },
  hasCsrf() {
    try { return !!localStorage.getItem(CSRF_KEY); } catch { return false; }
  },
  onExpired(fn: () => void) { onExpired = fn; },
};

if (typeof window !== "undefined") window.addEventListener("storage", (event) => {
  if (event.key !== CSRF_KEY && event.key !== null) return;
  revision++;
  accessToken = null;
  refreshing = null;
  onExpired?.();
});

const checkSession = (started: number) => {
  if (started !== revision) throw new ApiError(401, "session_changed", "Аккаунт изменился — повторите действие");
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

// Обновление идёт строго по одному и между вкладками браузера (Web Locks): cookie общая, и если две вкладки
// отправят одну и ту же cookie одновременно, бэкенд примет это за повторное использование и закроет сессию
const exclusive = <T,>(fn: () => Promise<T>): Promise<T> =>
  navigator.locks ? (navigator.locks.request("deanery-refresh", fn) as Promise<T>) : fn();

export function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  const started = revision;
  const pending = exclusive(async () => {
    if (started !== revision) return false;
    let csrf: string | null = null;
    try { csrf = localStorage.getItem(CSRF_KEY); } catch { /* нет доступа */ }
    if (!csrf) return false;
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}",
      });
      if (started !== revision) return false;
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { session.clear(); onExpired?.(); }
        return false;
      }
      const body = await res.json();
      if (started !== revision) return false;
      accessToken = body.access_token;
      return true;
    } catch {
      return false;
    }
  }).finally(() => { if (refreshing === pending) refreshing = null; });
  refreshing = pending;
  return pending;
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
  const started = revision;
  const method = (opts.method ?? (opts.json !== undefined || opts.body ? "POST" : "GET")).toUpperCase();
  const headers: Record<string, string> = { ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(buildUrl(path, opts.query), {
    method,
    headers, credentials: "include", signal: opts.signal,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  checkSession(started);
  if (res.status === 401 && !retried && !path.startsWith("/auth/login")) {
    const refreshed = await refreshSession();
    checkSession(started);
    if (refreshed) {
      if (method === "GET" || method === "HEAD" || Object.keys(headers).some((key) => key.toLowerCase() === "idempotency-key")) return apiRaw(path, opts, true);
      throw new ApiError(401, "session_refreshed", "Сессия обновлена — отправьте форму ещё раз");
    }
    session.clear();
    onExpired?.();
  }
  if (!res.ok) throw await readError(res);
  return res;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const started = revision;
  const res = await apiRaw(path, opts);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  checkSession(started);
  return (text ? JSON.parse(text) : undefined) as T;
}

export const newKey = () => crypto.randomUUID();
