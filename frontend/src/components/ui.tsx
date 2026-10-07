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

export function Modal({ onClose, children, label }: { onClose: () => void; children: ReactNode; label?: string }) {
  const close = useRef(onClose);
  close.current = onClose;
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
    <div className="modal-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={label} className="modal-box">{children}</div>
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
    <Modal onClose={onCancel} label={title}>
      <div className="dialog">
        <span className={`dialog-ico${danger ? " danger" : ""}`}><Icon name={danger ? "trash" : "sparkle"} /></span>
        <div><h3>{title}</h3>{text && <p>{text}</p>}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" onClick={onCancel}>Отменить</button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm} disabled={busy} autoFocus>{busy ? "Подождите…" : confirm}</button>
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

/* ── Ошибка с идентификатором запроса (для диагностики) ── */
export const ErrorNote = ({ text, requestId }: { text: string; requestId?: string }) => (
  <p className="form-error" role="alert">{text}{requestId && <small className="req-id">Код запроса: {requestId}</small>}</p>
);
