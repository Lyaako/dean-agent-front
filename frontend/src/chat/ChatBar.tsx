import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../components/Icon";
import { anyModalOpen, ConfirmDialog } from "../components/ui";
import { ATTACH_TYPES } from "../api/files";
import { useChat } from "./useChat";
import { useAttachments } from "./attachments/useAttachments";
import { ComposerThumbs, ContextDetails, FileViewer, MessageThumbs, type ViewTarget } from "./attachments/Thumbs";
import { ProposalDialog } from "./proposals/ProposalDialog";
import { TABLE_NAME } from "./proposals/useProposal";
import type { ChatMessage, ChatSummary } from "./store/ChatStore";
import { onChatPrefill } from "../lib/chatPrefill";

// Чат в шапке: свёрнут — строка ввода; развёрнут — список чатов слева и переписка (как в макете)
export function ChatBar({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const c = useChat();
  // Черновик (текст и вложения) у каждого чата свой; "new" — ещё не созданный чат
  const draftKey = c.chat?.id ?? "new";
  const att = useAttachments({ maxCount: c.attachments.maxCount, maxTotal: c.attachments.maxTotal }, draftKey);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const textVersions = useRef<Record<string, number>>({});
  const text = texts[draftKey] ?? "";
  const setText = (v: string) => { textVersions.current[draftKey] = (textVersions.current[draftKey] ?? 0) + 1; setTexts((t) => ({ ...t, [draftKey]: v })); };
  const [queued, setQueued] = useState(false);
  const [view, setView] = useState<ViewTarget | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const chatEl = useRef<HTMLElement>(null);
  const [slotH, setSlotH] = useState<number>();

  // Свёрнутый чат лежит поверх страницы — место под ним подстраиваем под его высоту, чтобы он не наезжал на контент
  useLayoutEffect(() => {
    const el = chatEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (!el.classList.contains("open")) setSlotH(el.offsetHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ⌘K / Ctrl+K — к полю ввода; Esc — свернуть чат
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.current?.focus(); }
      else if (e.key === "Escape" && open && !anyModalOpen()) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" }); }, [c.messages.length, c.busy, open]);

  const grow = () => { const t = input.current; if (t) { t.style.height = "40px"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; } };
  // Другой чат — другой черновик: подстраиваем высоту поля, ожидание отправки сбрасываем
  useEffect(() => { setQueued(false); requestAnimationFrame(grow); }, [draftKey]);

  // «Подготовить заново» из окна предложения: текст просьбы — в поле сообщения текущего чата, без отправки
  useEffect(() => onChatPrefill((t) => {
    setText(t);
    setOpen(true);
    requestAnimationFrame(() => { grow(); input.current?.focus(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [draftKey, setOpen]);

  // Можно отправить текст, вложения или и то и другое; файлы с ошибкой надо убрать или повторить
  const canSend = (!!text.trim() || att.items.length > 0) && !att.hasErrors && !c.anyBusy && !queued;

  function send() {
    const files = att.ready();
    if (!files) return;
    const msg = text.trim();
    if (!msg && !files.length) return;
    const version = textVersions.current[draftKey] ?? 0;
    const submittedIds = att.items.map((item) => item.id);
    c.send(msg, files, () => {
      submittedIds.forEach(att.remove);
      if ((textVersions.current[draftKey] ?? 0) === version) setTexts((t) => ({ ...t, [draftKey]: "" }));
      requestAnimationFrame(grow);
    });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    setOpen(true);
    // Файлы ещё проверяются — отправим, как только будут готовы
    if (att.pending) setQueued(true);
    else send();
  }

  useEffect(() => {
    if (!queued || att.pending) return;
    setQueued(false);
    if (!att.hasErrors) send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queued, att.pending]);

  return (
    <div className="chat-slot" style={slotH ? { height: slotH } : undefined}>
      <section ref={chatEl} className={`chat${open ? " open" : ""}${c.busy ? " busy" : ""}`} aria-label="Чат с агентом">
        <div className="chat-head">
          <button type="button" className="icon-btn" aria-label="Список чатов" aria-pressed={listOpen} onClick={() => setListOpen(!listOpen)}><Icon name="sidebar" /></button>
          <span className="orb" />
          <div className="who"><b>Агент деканата</b><small>{c.chat?.title ?? "Новый чат"}</small></div>
        </div>

        <div className="chat-body">
          {open && listOpen && <ChatList chats={c.chats} activeId={c.chat?.id} onOpen={c.openChat} onRename={c.renameChat} onRemove={c.removeChat}
            onNew={() => { c.newChat(); input.current?.focus(); }} />}
          <div className="chat-pane">
            <div className="messages" ref={box} aria-live="polite">
              <div className="thread">
                {!c.messages.length && <div className="hello"><span className="orb xl" /><h2>{c.loading ? "Загружаю чаты…" : "Чем помочь?"}</h2></div>}
                {c.messages.map((m) => (
                  <Message key={m.id} m={m} onOpenFile={(a) => setView({ name: a.filename, meta: a })}
                    onProposal={setProposal} />
                ))}
                {c.busy && (
                  <div className="msg agent">
                    <span className="orb busy" />
                    <div className="typing"><div className="dots3"><i /><i /><i /></div>{c.status && <small>{c.status}</small>}</div>
                  </div>
                )}
              </div>
            </div>

            <div className="composer">
              {att.items.length > 0 && (
                <ComposerThumbs items={att.items} onRemove={att.remove} onRetry={att.retry} onOpen={(f) => setView({ name: f.name, file: f })} />
              )}
              {att.notice && <small className="form-error attach-hint">{att.notice}</small>}
              {att.items.length > 0 && !c.attachments.agentReads && <small className="form-error attach-hint">Агент сейчас не готов принять вложения. При отправке файлы останутся в черновике.</small>}
              {c.notice && <div className="form-error attach-hint" role="alert">{c.notice} <button type="button" className="btn sm soft" onClick={c.retry}>{c.disconnected ? "Восстановить соединение" : "Повторить загрузку"}</button></div>}
              <form className="input-row" onSubmit={submit}>
                <input ref={fileInput} type="file" accept={ATTACH_TYPES.join(",")} multiple hidden
                  onChange={(e) => { if (e.target.files) att.add(e.target.files); e.target.value = ""; }} />
                <button type="button" className="icon-btn" title="Прикрепить файлы" aria-label="Прикрепить файлы" onClick={() => fileInput.current?.click()}><Icon name="clip" /></button>
                <textarea ref={input} rows={1} placeholder="Сообщение…" aria-label="Сообщение" value={text}
                  onChange={(e) => { setText(e.target.value); grow(); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
                {c.busy
                  ? <button type="button" className="icon-btn send" title={c.stopping ? "Останавливаю агента…" : !c.canStop ? "Восстанавливаю идентификатор запуска…" : "Остановить"} aria-label="Остановить" disabled={!c.canStop || c.stopping} onClick={c.stop}><Icon name="stop" /></button>
                  : queued
                    ? <button type="button" className="icon-btn send" title="Отправим, когда файлы загрузятся" aria-label="Ждём загрузку файлов" onClick={() => setQueued(false)}><span className="spinner sm" /></button>
                    : <button type="submit" className="icon-btn send" title="Отправить" aria-label="Отправить" disabled={!canSend}><Icon name="up" /></button>}
                <button type="button" className="icon-btn toggle" title={open ? "Свернуть чат" : "Развернуть чат"} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="down" /></button>
              </form>
            </div>
          </div>
        </div>
      </section>
      {view && <FileViewer target={view} onClose={() => setView(null)} />}
      {proposal && <ProposalDialog id={proposal} onClose={() => setProposal(null)} onDecided={() => { void c.refreshCurrent(); }} />}
    </div>
  );
}

// Копирование текста сообщения; запасной путь — для браузеров без Clipboard API
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = Object.assign(document.createElement("textarea"), { value: text });
    t.style.cssText = "position:fixed;opacity:0";
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="msg-acts">
      <button type="button" className="msg-act" aria-label={done ? "Скопировано" : "Копировать"}
        onClick={async () => { await copyText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
        <Icon name={done ? "check" : "copy"} />
      </button>
    </div>
  );
}

function Message({ m, onOpenFile, onProposal }: { m: ChatMessage; onOpenFile: (a: NonNullable<ChatMessage["attachments"]>[number]) => void; onProposal: (id: string) => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        {m.attachments?.length ? <MessageThumbs items={m.attachments} onOpen={onOpenFile} /> : null}
        {m.text && <div className="bubble">{m.text}</div>}
        <CopyButton text={m.text || (m.attachments ?? []).map((a) => a.filename).join(", ")} />
      </div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="msg agent error">
        <span className="dialog-ico danger sm"><Icon name="alert" /></span>
        <div className="body"><p>{m.text}</p>{m.requestId && <small className="req-id">Код запроса: {m.requestId}</small>}
          <ContextDetails context={m.attachment_context} />
          <CopyButton text={m.requestId ? `${m.text} (код запроса: ${m.requestId})` : m.text} /></div>
      </div>
    );
  }
  return (
    <div className="msg agent">
      <span className="orb" />
      <div className="body">
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ table: ({ children }) => <div className="mini"><table>{children}</table></div> }}>{m.text}</ReactMarkdown>
        </div>
        <ContextDetails context={m.attachment_context} />
        {m.proposals?.map((p) => {
          const d = m.decisions?.[p.id];
          return (
            <div key={p.id} className="proposal-card">
              <Icon name="sparkle" />
              <div><b>{p.explanation || "Агент предлагает изменение"}</b><small>{TABLE_NAME[p.preview.table] ?? p.preview.table} · {p.preview.operation === "INSERT" ? "новая запись" : `полей: ${p.preview.changed_columns.length}`}</small></div>
              {d ? <span className={`badge ${d === "approved" ? "ok" : "muted"}`}>{d === "approved" ? "Подтверждено" : "Отклонено"}</span> : null}
              <button className="btn sm soft go" onClick={() => onProposal(p.id)}>{d ? "Открыть" : "Посмотреть изменение"}<Icon name="arrow" /></button>
            </div>
          );
        })}
        <CopyButton text={m.text} />
      </div>
    </div>
  );
}

const dayGroup = (iso: string) => {
  const d = new Date(iso), t = new Date();
  const days = Math.floor((new Date(t.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  return days <= 0 ? "Сегодня" : days === 1 ? "Вчера" : "Ранее";
};

function ChatList({ chats, activeId, onOpen, onRename, onRemove, onNew }: {
  chats: ChatSummary[]; activeId?: string; onOpen: (id: string) => void; onRename: (id: string, t: string) => void; onRemove: (id: string) => void; onNew: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const cancelRename = useRef(false);
  const [removing, setRemoving] = useState<ChatSummary | null>(null);
  const groups = ["Сегодня", "Вчера", "Ранее"].map((g) => [g, chats.filter((c) => dayGroup(c.updatedAt) === g)] as const).filter(([, l]) => l.length);
  return (
    <aside className="chat-list" aria-label="Чаты">
      <button type="button" className="btn sm soft new-chat" onClick={onNew}><Icon name="plus" />Новый чат</button>
      {!chats.length && <p className="hint">Здесь будут ваши чаты</p>}
      {groups.map(([g, list]) => (
        <div key={g} className="cl-group">
          <small className="ff-l">{g}</small>
          {list.map((c) => editing?.id === c.id ? (
            <form key={c.id} className="cl-item editing" onSubmit={(e) => { e.preventDefault(); e.currentTarget.querySelector("input")?.blur(); }}>
              <input className="ff-in" autoFocus maxLength={255} value={editing.title} onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                onBlur={() => { if (!cancelRename.current) onRename(c.id, editing.title); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); cancelRename.current = true; setEditing(null); } }} />
            </form>
          ) : (
            <div key={c.id} className={`cl-item${c.id === activeId ? " active" : ""}`}>
              <button type="button" className="cl-open" onClick={() => onOpen(c.id)} title={c.title}><Icon name="message" /><span>{c.title}</span></button>
              <button type="button" className="cl-act" aria-label="Переименовать" onClick={() => { cancelRename.current = false; setEditing({ id: c.id, title: c.title }); }}><Icon name="edit" /></button>
              <button type="button" className="cl-act" aria-label="Удалить" onClick={() => setRemoving(c)}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      ))}
      {removing && (
        <ConfirmDialog title="Удалить чат?" text={`«${removing.title}» исчезнет из списка вместе с перепиской.`} confirm="Удалить" danger
          onConfirm={() => { onRemove(removing.id); setRemoving(null); }} onCancel={() => setRemoving(null)} />
      )}
    </aside>
  );
}
