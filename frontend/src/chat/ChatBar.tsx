import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../components/Icon";
import { anyModalOpen } from "../components/ui";
import { ATTACH_TYPES } from "../api/files";
import { useChat } from "./useChat";
import { useAttachments } from "./attachments/useAttachments";
import { ComposerThumbs, FileViewer, MessageThumbs, type ViewTarget } from "./attachments/Thumbs";
import { ProposalDialog } from "./proposals/ProposalDialog";
import { TABLE_NAME } from "./proposals/useProposal";
import type { ChatMessage, ChatSummary } from "./store/ChatStore";

// Чат в шапке: свёрнут — строка ввода; развёрнут — список чатов слева и переписка (как в макете)
export function ChatBar({ open, setOpen }: { open: boolean; setOpen: (v: boolean) => void }) {
  const c = useChat();
  const att = useAttachments({ maxCount: c.attachments.maxCount, maxTotal: c.attachments.maxTotal });
  const [text, setText] = useState("");
  const [view, setView] = useState<ViewTarget | null>(null);
  const [proposal, setProposal] = useState<{ id: string; msgId: string } | null>(null);
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
  const canSend = !!text.trim() && !att.pending && !c.anyBusy;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    const files = att.take();
    c.send(text.trim(), files);
    setText("");
    requestAnimationFrame(grow);
    setOpen(true);
  }

  const last = [...c.messages].reverse().find((m) => m.role !== "error");
  const kbd = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";

  return (
    <div className="chat-slot" style={slotH ? { height: slotH } : undefined}>
      <section ref={chatEl} className={`chat${open ? " open" : ""}${c.busy ? " busy" : ""}`} aria-label="Чат с агентом">
        <div className="chat-head">
          <button type="button" className="icon-btn" aria-label="Список чатов" aria-pressed={listOpen} onClick={() => setListOpen(!listOpen)}><Icon name="sidebar" /></button>
          <span className="orb" />
          <div className="who"><b>Агент деканата</b><small>{c.chat?.title ?? "Новый чат"}</small></div>
          <button type="button" className="btn ghost sm" onClick={() => { c.newChat(); input.current?.focus(); }}><Icon name="plus" /><span>Новый чат</span></button>
        </div>

        <div className="chat-body">
          {open && listOpen && <ChatList chats={c.chats} activeId={c.chat?.id} onOpen={c.openChat} onRename={c.renameChat} onRemove={c.removeChat} onNew={c.newChat} />}
          <div className="chat-pane">
            <div className="messages" ref={box} aria-live="polite">
              <div className="thread">
                {!c.messages.length && <div className="hello"><span className="orb xl" /><h2>Чем помочь?</h2></div>}
                {c.messages.map((m) => (
                  <Message key={m.id} m={m} onOpenFile={(a) => setView({ name: a.filename, meta: a })}
                    onProposal={(id) => setProposal({ id, msgId: m.id })} />
                ))}
                {c.busy && (
                  <div className="msg agent">
                    <span className="orb busy" />
                    <div className="typing"><div className="dots3"><i /><i /><i /></div>{c.status && <small>{c.status}</small>}</div>
                  </div>
                )}
              </div>
            </div>

            {!open && last && (
              <button type="button" className="peek" onClick={() => setOpen(true)}>
                {last.role === "agent" ? <span className="orb xs" /> : <span className="you">Вы</span>}
                <span className="t">{last.text}</span><span className="open">Открыть<Icon name="down" /></span>
              </button>
            )}

            <div className="composer">
              {att.items.length > 0 && (
                <ComposerThumbs items={att.items} onRemove={att.remove} onRetry={att.retry} onOpen={(f) => setView({ name: f.name, file: f })} />
              )}
              {att.items.length > 0 && !c.attachments.agentReads && <small className="hint attach-hint">Агент пока не читает вложения — файлы сохранятся на сервере и в истории чата</small>}
              {att.notice && <small className="form-error attach-hint">{att.notice}</small>}
              <form className="input-row" onSubmit={submit}>
                <input ref={fileInput} type="file" accept={ATTACH_TYPES.join(",")} multiple hidden
                  onChange={(e) => { if (e.target.files) att.add(e.target.files); e.target.value = ""; }} />
                <button type="button" className="icon-btn" title="Прикрепить файлы" aria-label="Прикрепить файлы" onClick={() => fileInput.current?.click()}><Icon name="clip" /></button>
                <textarea ref={input} rows={1} placeholder="Сообщение…" aria-label="Сообщение" value={text}
                  onChange={(e) => { setText(e.target.value); grow(); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
                <kbd className="kbd">{kbd}</kbd>
                {c.busy
                  ? <button type="button" className="icon-btn send" title="Остановить" aria-label="Остановить" onClick={c.stop}><Icon name="stop" /></button>
                  : <button type="submit" className="icon-btn send" title="Отправить" aria-label="Отправить" disabled={!canSend}><Icon name="up" /></button>}
                <button type="button" className="icon-btn toggle" title={open ? "Свернуть чат" : "Развернуть чат"} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="down" /></button>
              </form>
            </div>
          </div>
        </div>
      </section>
      {view && <FileViewer target={view} onClose={() => setView(null)} />}
      {proposal && <ProposalDialog id={proposal.id} onClose={() => setProposal(null)} onDecided={(s) => c.markDecision(proposal.msgId, proposal.id, s)} />}
    </div>
  );
}

function Message({ m, onOpenFile, onProposal }: { m: ChatMessage; onOpenFile: (a: NonNullable<ChatMessage["attachments"]>[number]) => void; onProposal: (id: string) => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        {m.attachments?.length ? <MessageThumbs items={m.attachments} onOpen={onOpenFile} /> : null}
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  if (m.role === "error") {
    return (
      <div className="msg agent error">
        <span className="dialog-ico danger sm"><Icon name="alert" /></span>
        <div className="body"><p>{m.text}</p>{m.requestId && <small className="req-id">Код запроса: {m.requestId}</small>}</div>
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
        {m.proposals?.map((p) => {
          const d = m.decisions?.[p.id];
          return (
            <div key={p.id} className="proposal-card">
              <Icon name="sparkle" />
              <div><b>{p.explanation || "Агент предлагает изменение"}</b><small>{TABLE_NAME[p.preview.table] ?? p.preview.table} · {p.preview.operation === "INSERT" ? "новая запись" : `полей: ${p.preview.changed_columns.length}`}</small></div>
              {d ? <span className={`badge ${d === "approved" ? "ok" : "muted"}`}>{d === "approved" ? "Применено" : "Отклонено"}</span> : null}
              <button className="btn sm soft go" onClick={() => onProposal(p.id)}>{d ? "Открыть" : "Посмотреть изменение"}<Icon name="arrow" /></button>
            </div>
          );
        })}
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
  const groups = ["Сегодня", "Вчера", "Ранее"].map((g) => [g, chats.filter((c) => dayGroup(c.updatedAt) === g)] as const).filter(([, l]) => l.length);
  return (
    <aside className="chat-list" aria-label="Чаты">
      <button type="button" className="btn sm soft new-chat" onClick={onNew}><Icon name="plus" />Новый чат</button>
      {!chats.length && <p className="hint">Здесь будут ваши чаты</p>}
      {groups.map(([g, list]) => (
        <div key={g} className="cl-group">
          <small className="ff-l">{g}</small>
          {list.map((c) => editing?.id === c.id ? (
            <form key={c.id} className="cl-item editing" onSubmit={(e) => { e.preventDefault(); onRename(c.id, editing.title); setEditing(null); }}>
              <input className="ff-in" autoFocus value={editing.title} onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                onBlur={() => { onRename(c.id, editing.title); setEditing(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(null); } }} />
            </form>
          ) : (
            <div key={c.id} className={`cl-item${c.id === activeId ? " active" : ""}`}>
              <button type="button" className="cl-open" onClick={() => onOpen(c.id)} title={c.title}><Icon name="message" /><span>{c.title}</span></button>
              <button type="button" className="cl-act" aria-label="Переименовать" onClick={() => setEditing({ id: c.id, title: c.title })}><Icon name="edit" /></button>
              <button type="button" className="cl-act" aria-label="Удалить" onClick={() => { if (confirm(`Удалить чат «${c.title}»?`)) onRemove(c.id); }}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
