import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

/* ── Метка ── */
export const Badge = ({ kind = "", children }: { kind?: string; children: ReactNode }) =>
  <span className={`badge ${kind}`}>{children}</span>;

/* ── Сегментированный переключатель ── */
export function Seg<T extends string>({ value, options, onChange, dark }: {
  value: T; options: [T, string, IconName?][]; onChange: (v: T) => void; dark?: boolean;
}) {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div className={`seg${dark ? " dark" : ""}`} role="group" style={{ ["--n" as string]: options.length, ["--i" as string]: i }}>
      {options.map(([v, l, ic]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {ic && <Icon name={ic} />}<span>{l}</span>
        </button>
      ))}
    </div>
  );
}

/* ── Окно поверх страницы: Esc и клик мимо закрывают; Esc закрывает только верхнее окно ── */
const modalStack: symbol[] = [];
export const anyModalOpen = () => modalStack.length > 0;

export function Modal({ onClose, children, label, outsideClose = true }: {
  onClose: () => void; children: ReactNode; label?: string;
  /** Закрывать кликом мимо окна. Формы с изменениями — нет: там закрытие только крестиком или Esc */
  outsideClose?: boolean;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const me = Symbol();
    modalStack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalStack[modalStack.length - 1] !== me) return;
      e.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      modalStack.splice(modalStack.indexOf(me), 1);
    };
  }, []);
  return createPortal(
    // События окна не уходят в компоненты, внутри которых оно открыто (React передаёт их через портал):
    // иначе отправка формы приказа отправляла бы и форму карточки под ней
    // Клик мимо — только по подложке именно этого окна (вложенные окна сюда тоже «всплывают»)
    <div className="modal-scrim" role="presentation" onSubmit={(e) => e.stopPropagation()}
      onMouseDown={(e) => { if (outsideClose && (e.target === e.currentTarget || e.target === box.current)) onClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} className="modal-box">{children}</div>
    </div>,
    document.body,
  );
}

/* ── Подтверждение (удаление и т. п.) в стиле окна макета ── */
export function ConfirmDialog({ title, text, confirm, danger, busy, error, onConfirm, onCancel }: {
  title: string; text?: ReactNode; confirm: string; danger?: boolean; busy?: boolean; error?: string | null;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal onClose={() => { if (!busy) onCancel(); }} label={title}>
      <div className="dialog confirm">
        <span className={`dialog-ico${danger ? " danger" : ""}`}><Icon name={danger ? "trash" : "sparkle"} /></span>
        <div><h3>{title}</h3>{text && <p>{text}</p>}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Отменить</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy} autoFocus>{busy ? "Подождите…" : confirm}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Закрытие формы с несохранёнными изменениями: сохранить, не сохранять или вернуться к форме ── */
export function UnsavedDialog({ onSave, onDiscard, onCancel, saveLabel = "Сохранить", title = "Сохранить изменения?", text = "В форме есть несохранённые изменения." }: {
  onSave: () => void; onDiscard: () => void; onCancel: () => void; saveLabel?: string; title?: string; text?: string;
}) {
  return (
    <Modal onClose={onCancel} label={title}>
      <div className="dialog confirm">
        <div><h3>{title}</h3><p>{text}</p></div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel}>Отменить</button>
          <span className="spacer" />
          <button className="btn" onClick={onDiscard}>Не сохранять</button>
          <button className="btn primary" onClick={onSave} autoFocus>{saveLabel}</button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Тосты ── */
type Toast = { id: number; text: string; out?: boolean; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const toast = useCallback((text: string, bad = false) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, bad }]);
    setTimeout(() => setList((l) => l.map((t) => (t.id === id ? { ...t, out: true } : t))), 2600);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 2900);
  }, []);
  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`toast${t.out ? " out" : ""}${t.bad ? " bad" : ""}`}>
            <span className="tick"><Icon name={t.bad ? "x" : "check"} /></span>{t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ── Текст ошибки с кодом макета (RW-07 и т. п.), если он есть ── */
export const CodedText = ({ text, code }: { text: string; code?: string }) =>
  <>{text}{code && <> <span className="err-code">{code}</span></>}</>;

/* ── Ошибка с идентификатором запроса (для диагностики) ── */
// Код запроса не показываем в тексте — он в подсказке при наведении, для диагностики
export const ErrorNote = ({ text, requestId, code }: { text: string; requestId?: string; code?: string }) => (
  <p className="form-error" role="alert" title={requestId ? `Код запроса: ${requestId}` : undefined}><CodedText text={text} code={code} /></p>
);
