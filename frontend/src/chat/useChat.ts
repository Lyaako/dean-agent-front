import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthProvider";
import { getCapabilities, streamChat, type ChatEvent } from "../api/agent";
import { ApiError, newKey } from "../api/client";
import { errorText, requestIdOf } from "../api/errors";
import { localChatStore } from "./store/localChatStore";
import { titleFrom, type AttachmentMeta, type Chat, type ChatMessage, type ChatSummary } from "./store/ChatStore";

const TOOL_STATUS: Record<string, string> = {
  query_deanery: "Ищу в базе деканата…",
  propose_sql_change: "Готовлю изменение…",
  search_regulations: "Ищу в нормативных документах…",
};

const now = () => new Date().toISOString();

export function useChat() {
  const { me } = useAuth();
  const store = useMemo(() => (me ? localChatStore(me.user_id) : null), [me]);
  const activeKey = me ? `deanery.chat.active.${me.user_id}` : "";

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);       // null — новый, ещё пустой чат
  const [busyChat, setBusyChat] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const chatRef = useRef<Chat | null>(null);
  chatRef.current = chat;
  const abortRef = useRef<AbortController | null>(null);
  const queue = useRef(Promise.resolve());

  const caps = useQuery({ queryKey: ["capabilities"], queryFn: getCapabilities, staleTime: 5 * 60_000, enabled: !!me });
  const att = caps.data?.attachment_context;

  const refreshList = useCallback(async () => { if (store) setChats(await store.list()); }, [store]);

  // Последний открытый чат — открываем снова
  useEffect(() => {
    if (!store) return;
    (async () => {
      await refreshList();
      let id: string | null = null;
      try { id = localStorage.getItem(activeKey); } catch { /* нет доступа */ }
      if (id) setChat(await store.get(id));
    })();
  }, [store, activeKey, refreshList]);

  const remember = (id: string | null) => {
    try { if (id) localStorage.setItem(activeKey, id); else localStorage.removeItem(activeKey); } catch { /* нет доступа */ }
  };

  // Изменения одного чата выполняются по очереди: ответ может прийти, когда открыт уже другой чат
  const update = useCallback((id: string, fn: (c: Chat) => Chat) => {
    queue.current = queue.current.then(async () => {
      if (!store) return;
      const base = chatRef.current?.id === id ? chatRef.current : await store.get(id);
      if (!base) return;
      const next = fn(base);
      await store.save(next);
      if (chatRef.current?.id === id) { chatRef.current = next; setChat(next); }
      await refreshList();
    });
    return queue.current;
  }, [store, refreshList]);

  const addMessage = (id: string, m: ChatMessage, patch: Partial<Chat> = {}) =>
    update(id, (c) => ({ ...c, ...patch, messages: [...c.messages, m], updatedAt: now() }));

  const send = useCallback(async (text: string, attachments: AttachmentMeta[] = []) => {
    if (!store || busyChat) return;
    let c = chatRef.current;
    if (!c) {
      c = { id: newKey(), title: titleFrom(text), sessionId: null, createdAt: now(), updatedAt: now(), messages: [] };
      await store.save(c);
      chatRef.current = c;
      setChat(c);
      remember(c.id);
    }
    const id = c.id;
    await addMessage(id, { id: newKey(), role: "user", text, at: now(), attachments: attachments.length ? attachments : undefined });

    const ac = new AbortController();
    abortRef.current = ac;
    setBusyChat(id);
    setStatus("Агент думает…");
    // Вложения уходят агенту, только когда он их понимает (иначе бэкенд ответит 412)
    const refs = att?.agent_supported ? attachments.map(({ file_id, version_id }) => ({ file_id, version_id })) : [];
    let gotAnswer = false;
    try {
      await streamChat({ message: text, session_id: c.sessionId, attachments: refs }, (ev: ChatEvent) => {
        switch (ev.event) {
          case "status": setStatus(ev.data.message || "Агент думает…"); break;
          case "session": update(id, (x) => ({ ...x, sessionId: ev.data.session_id })); break;
          case "tool_call": setStatus(TOOL_STATUS[ev.data.name] ?? "Работаю с данными…"); break;
          case "done":
            gotAnswer = true;
            addMessage(id, { id: newKey(), role: "agent", text: ev.data.answer, at: now(), proposals: ev.data.proposals, tools: ev.data.tools_used },
              { sessionId: ev.data.session_id });
            break;
          case "error":
            gotAnswer = true;
            addMessage(id, { id: newKey(), role: "error", text: ev.data.message || "Агент не ответил", at: now() });
            break;
        }
      }, ac.signal);
      if (!gotAnswer) await addMessage(id, { id: newKey(), role: "error", text: "Соединение прервалось до ответа агента", at: now() });
    } catch (e) {
      // Сессия на сервере пропала — следующий вопрос начнёт новую
      const lost = e instanceof ApiError && e.code === "session_not_found";
      await addMessage(id, { id: newKey(), role: "error", text: ac.signal.aborted ? "Остановлено. Агент мог успеть выполнить запрос на сервере." : errorText(e), at: now(), requestId: requestIdOf(e) },
        lost ? { sessionId: null } : {});
    } finally {
      abortRef.current = null;
      setBusyChat(null);
      setStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, busyChat, att?.agent_supported, update]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newChat = useCallback(() => { setChat(null); remember(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const openChat = useCallback(async (id: string) => {
    if (!store) return;
    const c = await store.get(id);
    setChat(c);
    remember(c?.id ?? null);
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const renameChat = useCallback(async (id: string, title: string) => {
    if (!store || !title.trim()) return;
    await store.rename(id, title.trim());
    if (chatRef.current?.id === id) setChat({ ...chatRef.current, title: title.trim() });
    await refreshList();
  }, [store, refreshList]);
  const removeChat = useCallback(async (id: string) => {
    if (!store) return;
    await store.remove(id);
    if (chatRef.current?.id === id) newChat();
    await refreshList();
  }, [store, refreshList, newChat]);

  const markDecision = useCallback((msgId: string, proposalId: string, s: "approved" | "rejected") => {
    const id = chatRef.current?.id;
    if (!id) return;
    update(id, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, decisions: { ...m.decisions, [proposalId]: s } } : m)) }));
  }, [update]);

  return {
    chats, chat, messages: chat?.messages ?? [],
    busy: !!busyChat && busyChat === chat?.id, anyBusy: !!busyChat, status,
    send, stop, newChat, openChat, renameChat, removeChat, markDecision,
    attachments: {
      agentReads: !!att?.agent_supported,
      maxCount: att?.max_attachments ?? 5,
      maxTotal: att?.max_total_bytes ?? 20_000_000,
    },
  };
}
