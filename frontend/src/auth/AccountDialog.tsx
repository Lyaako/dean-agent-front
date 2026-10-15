import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchProfile, ROLE_NAME, type Profile } from "../api/auth";
import { ApiError } from "../api/client";
import { errorText, requestIdOf } from "../api/errors";
import { ConfirmDialog, ErrorNote, Modal, Seg, useToast } from "../components/ui";
import { Icon } from "../components/Icon";
import { D, human, initials, plural, tone } from "../lib/format";
import { setTheme, useThemePref, type ThemePref } from "../lib/theme";
import { useAuth } from "./AuthProvider";

/* ── Смена пароля: поля и проверки общие для кабинета и обязательной смены после сброса ── */
type PwKey = "cur" | "next" | "rep";
type Pw = Record<PwKey, string>;
type PwErrors = Partial<Record<PwKey, string>>;

const PW_FIELDS: [PwKey, string, string][] = [
  ["cur", "Текущий пароль", "current-password"],
  ["next", "Новый пароль", "new-password"],
  ["rep", "Повторите новый пароль", "new-password"],
];

function pwErrors({ cur, next, rep }: Pw): PwErrors {
  const err: PwErrors = {};
  if (!cur) err.cur = "Введите текущий пароль";
  if (next.length < 8) err.next = "Не короче 8 символов";
  else if (next === cur) err.next = "Новый пароль совпадает с текущим";
  if (!err.next && rep !== next) err.rep = "Пароли не совпадают";
  return err;
}

// Ошибку сервера показываем под полем, к которому она относится; остальные — общей строкой под формой
function serverPwError(e: unknown): PwErrors | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === "invalid_current_password") return { cur: errorText(e) };
  if (e.code === "password_unchanged") return { next: errorText(e) };
  return null;
}

function usePasswordForm(initialCur: string, onSubmit: (cur: string, next: string) => Promise<void>) {
  const [pw, setPw] = useState<Pw>({ cur: initialCur, next: "", rep: "" });
  const [errors, setErrors] = useState<PwErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const pending = useRef<string | null>(null);
  const focus = (k: string) => form.current?.querySelector<HTMLInputElement>(`#pw-${k}`)?.focus();
  // Поле с ошибкой сервера разблокируется только после перерисовки — фокус ставим следом
  useEffect(() => {
    if (busy || !pending.current) return;
    focus(pending.current);
    pending.current = null;
  }, [busy]);

  const change = (k: PwKey, v: string) => {
    setPw((p) => ({ ...p, [k]: v }));
    if (errors[k]) setErrors(({ [k]: _, ...rest }) => rest);
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const err = pwErrors(pw);
    setErrors(err);
    setFailure(null);
    const first = Object.keys(err)[0];
    if (first) return focus(first);
    setBusy(true);
    try {
      await onSubmit(pw.cur, pw.next);
      setPw({ cur: "", next: "", rep: "" });
    } catch (ex) {
      const byField = serverPwError(ex);
      if (byField) { setErrors(byField); pending.current = Object.keys(byField)[0]; } else setFailure(ex);
    } finally {
      setBusy(false);
    }
  }
  return { pw, errors, failure, busy, form, change, submit };
}

function PwFields({ list, f }: { list: [PwKey, string, string][]; f: ReturnType<typeof usePasswordForm> }) {
  return (
    <>
      {list.map(([k, label, ac]) => (
        <div key={k} className={`field form-field${f.errors[k] ? " invalid" : ""}`}>
          <label htmlFor={`pw-${k}`}>{label}</label>
          <input id={`pw-${k}`} className="text-input" type="password" value={f.pw[k]} autoComplete={ac} disabled={f.busy}
            onChange={(e) => f.change(k, e.target.value)} />
          {f.errors[k] ? <small className="field-error" role="alert">{f.errors[k]}</small>
            : k === "next" && <small className="hint">Не короче 8 символов</small>}
        </div>
      ))}
    </>
  );
}

/* ── Личный кабинет: профиль, оформление и безопасность ── */
type Tab = "profile" | "theme" | "security";
const THEMES: [ThemePref, string][] = [["light", "Светлая"], ["dark", "Тёмная"], ["system", "Как в системе"]];

const fullDate = (s: string) => `${human(s)} ${s.slice(0, 4)}`;
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

function workSince(hire: string) {
  const years = Math.floor((Date.now() - D(hire).getTime()) / (365.25 * 864e5));
  return `${fullDate(hire)} · ${years} ${plural(years, "год", "года", "лет")}`;
}

// Поля зависят от роли: у студента — учёба, у сотрудника — работа, у администратора — только учётная запись
function profileFields(p: Profile, login: string): [string, string][] {
  if (p.role === "student") return [
    ["Логин", login], ["Зачётная книжка", show(p.record_book_number)], ["Группа", show(p.group)],
    ["Курс", p.course ? `${p.course} курс` : "—"], ["Основа обучения", show(p.funding)], ["Статус", show(p.status)],
    ["Телефон", show(p.phone)], ["Почта", show(p.email)],
  ];
  if (p.role === "admin") return [["Логин", login], ["Роль", ROLE_NAME.admin], ["Почта", show(p.email)], ["Телефон", show(p.phone)]];
  return [
    ["Логин", login], ["Табельный номер", show(p.personnel_number)], ["Должность", show(p.position)], ["Подразделение", show(p.unit)],
    ["Ставка", p.employment_rate == null ? "—" : String(p.employment_rate).replace(".", ",")],
    ["Работает с", p.hire_date ? workSince(p.hire_date) : "—"], ["Телефон", show(p.phone)], ["Почта", show(p.email)],
  ];
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const { me, role, fullName, changePassword, logoutAll } = useAuth();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("profile");
  const [askLogoutAll, setAskLogoutAll] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const themePref = useThemePref();
  const profile = useQuery({ queryKey: ["me", "profile"], queryFn: fetchProfile });
  const pwForm = usePasswordForm("", async (cur, next) => { await changePassword(cur, next); toast("Пароль изменён"); });

  const login = me?.login ?? "";
  const name = fullName || login;

  const profilePane = profile.data ? (
    <>
      <div className="kv-grid acc-kv">
        {profileFields(profile.data, login).map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}
      </div>
      <p className="hint acc-note">{role === "student"
        ? "Данные ведёт деканат. Если что-то неверно — обратитесь в деканат."
        : "Данные ведёт отдел кадров. Если что-то неверно — напишите администратору."}</p>
    </>
  ) : profile.error
    ? <ErrorNote text={errorText(profile.error)} requestId={requestIdOf(profile.error)} />
    : <p className="hint acc-note">Загружаем…</p>;

  const themePane = (
    <div className="theme-opts" role="radiogroup" aria-label="Тема">
      {THEMES.map(([v, l]) => (
        <button key={v} type="button" className="theme-opt" role="radio" aria-checked={themePref === v} onClick={() => setTheme(v)}>
          <span className={`theme-pic ${v}`} aria-hidden="true"><i /><i /><i /></span><span>{l}</span>
        </button>
      ))}
    </div>
  );

  const securityPane = (
    <>
      <form ref={pwForm.form} className="acc-block" onSubmit={pwForm.submit} noValidate>
        <h4>Смена пароля</h4>
        <div className="acc-pw"><PwFields list={PW_FIELDS} f={pwForm} /></div>
        {pwForm.failure != null && <ErrorNote text={errorText(pwForm.failure)} requestId={requestIdOf(pwForm.failure)} />}
        <div><button className="btn sm primary" disabled={pwForm.busy}>{pwForm.busy ? "Меняем…" : "Сменить пароль"}</button></div>
      </form>
      <div className="acc-block">
        <h4>Сеансы</h4>
        <div>
          <button type="button" className="btn sm ghost danger-text" onClick={() => setAskLogoutAll(true)}>
            <Icon name="logout" />Выйти на всех устройствах
          </button>
        </div>
      </div>
    </>
  );

  const panes: Record<Tab, ReactNode> = { profile: profilePane, theme: themePane, security: securityPane };

  return (
    <>
      <Modal onClose={onClose} label="Личный кабинет">
        <div className="dialog form-dialog account">
          <div className="form-head">
            <div className="acc-who">
              <span className={`avatar t${tone(name)}`}>{initials(name)}</span>
              <div><h3>{name}</h3><p>{role ? ROLE_NAME[role] : ""} · {login}</p></div>
            </div>
            <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button>
          </div>
          <div className="form-body">
            <Seg value={tab} onChange={setTab} options={[["profile", "Личные данные"], ["theme", "Оформление"], ["security", "Безопасность"]]} />
            <div className="acc-panes">
              {(Object.keys(panes) as Tab[]).map((t) => (
                <div key={t} className={`acc-pane${t === tab ? " on" : ""}`} inert={t !== tab} aria-hidden={t !== tab}>{panes[t]}</div>
              ))}
            </div>
          </div>
        </div>
      </Modal>
      {askLogoutAll && (
        <ConfirmDialog title="Выйти на всех устройствах?" text="Понадобится заново войти везде, в том числе в этом браузере."
          confirm="Выйти везде" danger busy={leaving}
          onCancel={() => setAskLogoutAll(false)}
          onConfirm={async () => { setLeaving(true); await logoutAll(); }} />
      )}
    </>
  );
}

/* ── Обязательная смена пароля после сброса администратором.
   Окно не закрывается (нет крестика, Esc и клик мимо не действуют), пока пароль не сменён.
   Временный пароль, введённый при входе, подставляется как текущий; если его нет (например, вкладка открыта заново) — спрашиваем ── */
export function MustChangeDialog() {
  const { me, tempPassword, changePassword } = useAuth();
  const toast = useToast();
  const known = tempPassword();
  const f = usePasswordForm(known ?? "", async (cur, next) => { await changePassword(cur, next); toast("Пароль изменён"); });
  const list: [PwKey, string, string][] = known ? PW_FIELDS.slice(1) : [["cur", "Временный пароль", "current-password"], ...PW_FIELDS.slice(1)];
  useEffect(() => { f.form.current?.querySelector("input")?.focus(); }, [f.form]);
  return (
    <Modal onClose={() => {}} outsideClose={false} label="Задайте новый пароль">
      <form ref={f.form} className="dialog form-dialog" onSubmit={f.submit} noValidate>
        <div className="form-head"><div><h3>Задайте новый пароль</h3><p>{me?.login} · вход по временному паролю</p></div></div>
        <div className="form-body">
          <div className="form-note">Пароль сброшен администратором. Чтобы продолжить, задайте свой пароль.</div>
          <div className="form-grid"><PwFields list={list} f={f} /></div>
          {f.failure != null && <ErrorNote text={errorText(f.failure)} requestId={requestIdOf(f.failure)} />}
        </div>
        <div className="actions">
          <span className="spacer" />
          <button className="btn primary" disabled={f.busy}>{f.busy ? "Меняем…" : "Сменить пароль"}</button>
        </div>
      </form>
    </Modal>
  );
}
