import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { cancelRun, getCapabilities, replayChat, streamChat, type ChatEvent } from "../api/agent";
import { ApiError, newKey } from "../api/client";
import { errorText } from "../api/errors";
import { serverChatStore as store } from "./store/serverChatStore";
import { activeChat, readPending, savePending, type PendingRun } from "./store/recovery";
import { titleFrom, type AttachmentMeta, type Chat, type ChatSummary } from "./store/ChatStore";

const TOOL_STATUS: Record<string, string> = {
  query_deanery: "Ищу в базе деканата…", propose_sql_change: "Готовлю изменение…", search_regulations: "Ищу в нормативных документах…",
};
type Attempt = PendingRun & { draftTicket?: number; onAccepted?: () => void; status?: string; error?: string; disconnected?: boolean; stopping?: boolean };

export function useChat() {
  const { me } = useAuth();
  const userId = me?.user_id;
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [pending, setPending] = useState<Attempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  const pendingRef = useRef<Attempt[]>([]);
  const recoveryBlocked = useRef(false);
  const scope = useRef<AbortController | null>(null);
  const streams = useRef(new Map<string, AbortController>());
  const opening = useRef(0);
  const renameVersions = useRef(new Map<string, number>());
  const caps = useQuery({ queryKey: ["capabilities", userId], queryFn: getCapabilities, staleTime: 30_000, enabled: userId !== undefined });
  const att = caps.data?.attachment_context;
  const setCurrent = (value: Chat | null) => { chatRef.current = value; setChat(value); };
  const persist = () => {
    setPending([...pendingRef.current]);
    if (recoveryBlocked.current) return false;
    try {
      if (userId !== undefined) savePending(userId, pendingRef.current);
      setStorageNotice(null);
      return true;
    } catch {
      setStorageNotice("Браузер не сохраняет восстановление чата. Не закрывайте страницу, пока отправка не завершится.");
      return false;
    }
  };
  const forget = (attempt: Attempt) => {
    pendingRef.current = pendingRef.current.filter((a) => a !== attempt);
    persist();
  };
  const refreshList = useCallback(async (signal?: AbortSignal) => {
    const result = await store.list(signal);
    if (!signal?.aborted) setChats(result);
  }, []);
  const syncChat = useCallback(async (id: string, signal?: AbortSignal) => {
    const result = await store.get(id, signal);
    if (!signal?.aborted && chatRef.current?.id === id) setCurrent(result);
    return result;
  }, []);

  async function connect(attempt: Attempt) {
    const lifetime = scope.current;
    if (!lifetime || lifetime.signal.aborted || streams.current.has(attempt.key) || userId === undefined) return;
    const ac = new AbortController();
    streams.current.set(attempt.key, ac);
    const abort = () => ac.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    const alive = () => !ac.signal.aborted && scope.current === lifetime && pendingRef.current.includes(attempt);
    attempt.disconnected = false; attempt.error = undefined;
    persist();
    const accepted = () => { attempt.onAccepted?.(); attempt.onAccepted = undefined; };
    try {
      for (let failures = 0; ; failures++) {
        try {
          if (!attempt.chatId) {
            const info = await store.create(attempt.title, attempt.createKey, ac.signal);
            if (!alive()) return;
            attempt.chatId = info.id;
            attempt.body = { ...attempt.body!, session_id: info.id };
            persist();
          }
          if (!attempt.terminal) {
            attempt.status = failures ? "Восстанавливаю соединение…" : "Агент думает…";
            persist();
            const onEvent = async (ev: ChatEvent) => {
              if (!alive() || ev.id <= attempt.after) return;
              if (ev.event === "session") {
                if (ev.data.session_id !== attempt.chatId || (attempt.runId && attempt.runId !== ev.data.run_id)) throw new Error("Событие относится к другому запуску");
                attempt.runId = ev.data.run_id;
                accepted();
                const current = await syncChat(attempt.chatId, ac.signal);
                if (alive() && !chatRef.current && attempt.draftTicket === opening.current) {
                  setCurrent(current); activeChat(userId, current.id);
                }
              } else if (ev.event === "status") attempt.status = ev.data.message || "Агент думает…";
              else if (ev.event === "tool_call") attempt.status = TOOL_STATUS[ev.data.name] ?? "Работаю с данными…";
              else if (ev.event === "done" || ev.event === "error") {
                if ((ev.data.run_id && attempt.runId && ev.data.run_id !== attempt.runId)
                  || (ev.data.session_id && ev.data.session_id !== attempt.chatId)) throw new Error("Событие относится к другому запуску");
                attempt.runId = ev.data.run_id ?? attempt.runId;
                attempt.terminal = true;
                accepted();
              }
              if (!alive()) return;
              attempt.after = ev.id;
              persist();
            };
            if (attempt.runId) await replayChat(attempt.runId, attempt.after, onEvent, ac.signal);
            else if (attempt.body) await streamChat(attempt.body, attempt.key, onEvent, ac.signal);
            if (!alive()) return;
            if (!attempt.terminal) {
              const current = await syncChat(attempt.chatId, ac.signal);
              if (attempt.runId && current.messages.some((m) => m.runId === attempt.runId && m.role !== "user")) attempt.terminal = true;
              else throw new Error("Соединение прервалось. Запуск продолжается на сервере.");
            }
          }
          const current = await syncChat(attempt.chatId, ac.signal);
          await refreshList(ac.signal);
          if (!alive()) return;
          forget(attempt);
          if (chatRef.current?.id === current.id) observe(current);
          return;
        } catch (e) {
          if (!alive()) return;
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
            if (!attempt.runId) {
              forget(attempt);
              setNotice(errorText(e));
            }
            throw e;
          }
          if (failures >= 2) throw e;
          attempt.status = "Связь прервалась. Восстанавливаю тот же запуск…"; persist();
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); ac.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, 1000 * (failures + 1));
            ac.signal.addEventListener("abort", done, { once: true });
          });
          if (!alive()) return;
        }
      }
    } catch (e) {
      if (alive()) { attempt.error = errorText(e); attempt.disconnected = true; persist(); }
    } finally {
      lifetime.signal.removeEventListener("abort", abort);
      if (streams.current.get(attempt.key) === ac) streams.current.delete(attempt.key);
    }
  }
  const connectRef = useRef(connect);
  connectRef.current = connect;

  function observe(current: Chat) {
    if (!current.activeRunId) return;
    let attempt = pendingRef.current.find((a) => a.chatId === current.id);
    if (!attempt) {
      attempt = { key: newKey(), createKey: newKey(), title: current.title, body: null, chatId: current.id, runId: current.activeRunId, after: 0, terminal: false };
      pendingRef.current.push(attempt); persist();
    }
    void connectRef.current(attempt);
  }
  async function loadCurrent(signal: AbortSignal) {
    const ticket = opening.current;
    await refreshList(signal);
    const id = userId === undefined ? null : activeChat(userId) ?? pendingRef.current.find((a) => a.chatId)?.chatId;
    let current: Chat | null = null;
    if (id) {
      try { current = await store.get(id, signal); }
      catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; if (userId !== undefined) activeChat(userId, null); }
    }
    if (signal.aborted || ticket !== opening.current) return;
    setCurrent(current);
    if (current) observe(current);
  }
  useEffect(() => {
    const lifetime = new AbortController();
    scope.current = lifetime;
    streams.current = new Map();
    opening.current++;
    setCurrent(null); setChats([]); setNotice(null); setStorageNotice(null); setLoading(true);
    recoveryBlocked.current = false;
    let saved: Attempt[] = [];
    try {
      if (userId !== undefined) saved = readPending(userId);
      const uncreated = saved.filter((a) => !a.chatId).at(-1);
      if (uncreated) uncreated.draftTicket = opening.current;
    } catch (e) { recoveryBlocked.current = true; setStorageNotice(`${errorText(e)} Новые отправки приостановлены; перезагрузите страницу или завершите сеанс.`); }
    pendingRef.current = saved; setPending(saved);
    void (async () => {
      if (userId === undefined) { setLoading(false); return; }
      try { await loadCurrent(lifetime.signal); }
      catch (e) { if (!lifetime.signal.aborted) setNotice(errorText(e)); }
      finally {
        if (!lifetime.signal.aborted) {
          setLoading(false);
          for (const attempt of saved) void connectRef.current(attempt);
        }
      }
    })();
    // Closing the page only detaches subscriptions. Stop is an explicit server command.
    return () => lifetime.abort();
  }, [userId, refreshList]);

  const currentAttempt = () => pendingRef.current.find((a) => chatRef.current ? a.chatId === chatRef.current.id : a.draftTicket === opening.current);
  function send(text: string, attachments: AttachmentMeta[] = [], onAccepted?: () => void): boolean {
    if (userId === undefined || loading || currentAttempt() || chatRef.current?.activeRunId || (!text.trim() && !attachments.length)) return false;
    if (attachments.length && (!att?.backend_supported || !att.agent_supported || att.agent_status !== "ready")) {
      setNotice("Агент сейчас не может принять вложения. Проверьте доступность и повторите отправку; файлы сохранены в черновике.");
      void caps.refetch(); return false;
    }
    const names = attachments.map((a) => a.filename).join(", ");
    const message = text.trim() || `Вложения: ${names}`;
    if (message.length > 16000) { setNotice("Сообщение должно содержать не больше 16000 символов"); return false; }
    const current = chatRef.current;
    const attempt: Attempt = {
      key: newKey(), createKey: newKey(), title: current?.title ?? titleFrom(message),
      body: { message, ...(current ? { session_id: current.id } : {}), ...(attachments.length ? { attachments: attachments.map(({ file_id, version_id }) => ({ file_id, version_id })) } : {}) },
      chatId: current?.id ?? null, runId: null, after: 0, terminal: false, draftTicket: opening.current, onAccepted,
    };
    pendingRef.current.push(attempt);
    if (!persist()) {
      pendingRef.current = pendingRef.current.filter((a) => a !== attempt); setPending([...pendingRef.current]);
      setNotice("Отправка не начата: браузер не смог сохранить ключ восстановления. Черновик сохранён на этой странице. Перезагрузите страницу или завершите сеанс.");
      return false;
    }
    setNotice(null); void connect(attempt); return true;
  }
  async function stop() {
    const attempt = currentAttempt();
    const runId = attempt?.runId ?? chatRef.current?.activeRunId;
    if (!runId || attempt?.stopping) return;
    const lifetime = scope.current;
    if (attempt) { attempt.stopping = true; persist(); }
    try {
      const result = await cancelRun(runId);
      if (scope.current !== lifetime || lifetime?.signal.aborted) return;
      if (attempt) {
        attempt.status = result.stop_requested ? "Останавливаю агента…" : "Получаю завершённый ответ…"; persist();
        void connect(attempt);
      } else if (chatRef.current) observe(chatRef.current);
    } catch (e) {
      if (scope.current === lifetime && !lifetime?.signal.aborted) {
        setNotice(errorText(e)); if (attempt) { attempt.stopping = false; persist(); }
      }
    }
  }
  function newChat() { opening.current++; setCurrent(null); setNotice(null); if (userId !== undefined) activeChat(userId, null); }
  async function openChat(id: string) {
    const ticket = ++opening.current, signal = scope.current?.signal;
    try {
      const value = await store.get(id, signal);
      if (signal?.aborted || ticket !== opening.current) return;
      setCurrent(value); setNotice(null);
      if (userId !== undefined) activeChat(userId, id);
      observe(value);
    } catch (e) { if (!signal?.aborted && ticket === opening.current) setNotice(errorText(e)); }
  }
  async function renameChat(id: string, title: string) {
    if (!title.trim()) return;
    if (title.trim().length > 255) { setNotice("Название чата должно содержать не больше 255 символов"); return; }
    const signal = scope.current?.signal, version = (renameVersions.current.get(id) ?? 0) + 1;
    renameVersions.current.set(id, version);
    try {
      await store.rename(id, title.trim());
      if (signal?.aborted) return;
      if (renameVersions.current.get(id) === version) await syncChat(id, signal);
      await refreshList(signal);
    } catch (e) { if (!signal?.aborted) setNotice(errorText(e)); }
  }
  async function removeChat(id: string) {
    const signal = scope.current?.signal;
    try {
      await store.remove(id);
      if (signal?.aborted) return;
      if (chatRef.current?.id === id) newChat();
      for (const attempt of pendingRef.current.filter((a) => a.chatId === id)) { streams.current.get(attempt.key)?.abort(); forget(attempt); }
      await refreshList(signal);
    } catch (e) { if (!signal?.aborted) setNotice(e instanceof ApiError && e.code === "session_busy" ? "Сначала остановите агента" : errorText(e)); }
  }
  async function refreshCurrent() {
    const signal = scope.current?.signal;
    try { if (chatRef.current) { const value = await syncChat(chatRef.current.id, signal); if (!signal?.aborted) observe(value); } await refreshList(signal); }
    catch (e) { if (!signal?.aborted) setNotice(errorText(e)); }
  }
  function retry() {
    setNotice(null);
    const attempt = currentAttempt(), signal = scope.current?.signal;
    if (attempt) void connect(attempt);
    else if (chatRef.current) void refreshCurrent();
    else if (signal) void loadCurrent(signal).catch((e) => { if (!signal.aborted) setNotice(errorText(e)); });
    void caps.refetch();
  }
  const visible = pending.find((a) => chat ? a.chatId === chat.id : a.draftTicket === opening.current);
  const busy = !!visible || !!chat?.activeRunId;
  return {
    chats, chat, messages: chat?.messages ?? [], busy, anyBusy: busy || loading, loading, status: visible?.status,
    notice: visible?.error ?? notice ?? storageNotice, disconnected: !!visible?.disconnected, stopping: !!visible?.stopping,
    canStop: !!(visible?.runId ?? chat?.activeRunId), send, stop, newChat, openChat, renameChat, removeChat, refreshCurrent, retry,
    attachments: { agentReads: !!att?.backend_supported && !!att.agent_supported && att.agent_status === "ready", maxCount: att?.max_attachments ?? 5, maxTotal: att?.max_total_bytes ?? 20_000_000 },
  };
}
