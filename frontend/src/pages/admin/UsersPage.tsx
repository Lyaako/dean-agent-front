import { useMemo, useRef, useState } from "react";
import { Page } from "../../components/Shell";
import { Badge, ConfirmDialog, Modal, useToast } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { TableTools } from "../../components/table/TableTools";
import { DataTable } from "../../components/table/DataTable";
import { useTableState } from "../../components/table/useTableState";
import { applyTable, type Column } from "../../components/table/tableLogic";
import { useResource } from "../../api/resources";
import { ROLE_NAME, type Role } from "../../api/auth";
import { ApiError } from "../../api/client";
import { errorCode, errorText } from "../../api/errors";
import { resetPassword, type AppUser } from "../../api/admin";
import { fmtDate } from "../../lib/format";

/* ═════════ ПОЛЬЗОВАТЕЛИ (администратор) ═════════
   Только просмотр: роль и доступ задаются учётной записью в базе. Админ может только сбросить пароль */

const ROLE_KIND: Record<Role, string> = { admin: "bad", director: "warn", dean_staff: "info", teacher: "ok", student: "muted" };
const RoleBadge = ({ role }: { role: Role }) => <Badge kind={ROLE_KIND[role]}>{ROLE_NAME[role] ?? role}</Badge>;
const AccessBadge = ({ on }: { on: boolean }) => <Badge kind={on ? "ok" : "muted"}>{on ? "Активен" : "Отключён"}</Badge>;

const COLS: Column<AppUser>[] = [
  { label: "Логин", field: "login", filter: "text", bold: true, render: (r) => <b>{r.login}</b> },
  { label: "Человек", field: "person", filter: "text" },
  { label: "Роль", field: (r) => ROLE_NAME[r.role] ?? r.role, filter: "enum", badge: true, render: (r) => <RoleBadge role={r.role} /> },
  { label: "Доступ", field: (r) => (r.is_active ? "Активен" : "Отключён"), filter: "enum", badge: true, render: (r) => <AccessBadge on={r.is_active} /> },
  { label: "Последний вход", field: (r) => r.last_login_at?.slice(0, 10) ?? null, filter: "date" },
];

export function UsersPage() {
  const data = useResource("app_user");
  const rows = useMemo(() => (data.data ?? []) as unknown as AppUser[], [data.data]);
  const [state, set] = useTableState("users", COLS);
  const shown = useMemo(() => applyTable(state, COLS, rows), [state, rows]);
  const [open, setOpen] = useState<AppUser | null>(null);
  return (
    <Page title="Пользователи">
      <TableTools state={state} set={set} cols={COLS} rows={rows} />
      <DataTable cols={COLS} rows={shown} base={rows} state={state} set={set} rowKey={(r) => String(r.user_id)} onRowClick={setOpen}
        loading={data.isLoading} error={data.error ? errorText(data.error) : null} onRetry={() => data.refetch()} />
      {open && <UserDialog u={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function UserDialog({ u, onClose }: { u: AppUser; onClose: () => void }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const key = useRef<string | null>(null);

  async function reset() {
    setBusy(true); setErr(null);
    try {
      key.current ??= crypto.randomUUID();   // повтор после сбоя сети — с тем же ключом
      const r = await resetPassword(u.user_id, key.current);
      key.current = null;
      setAsk(false);
      setPassword(r.temporary_password);
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) key.current = null;
      // 409 password_already_issued — повторный запрос пароль не раскрывает
      setErr(errorText(e) + (errorCode(e) ? ` · ${errorCode(e)}` : ""));
    } finally { setBusy(false); }
  }

  if (password) return <TempPasswordDialog u={u} password={password} onClose={onClose} onCopied={() => toast("Пароль скопирован")} onCopyFailed={() => toast("Не удалось скопировать — выделите пароль вручную", true)} />;
  return (
    <>
      <Modal onClose={onClose} label={u.login}>
        <div className="dialog form-dialog">
          <div className="form-head"><div><h3>{u.login}</h3><p>{u.person ?? "—"}</p></div>
            <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button></div>
          <div className="form-body">
            <div className="kv-grid">
              <div><small>Роль</small><b><RoleBadge role={u.role} /></b></div>
              <div><small>Доступ</small><b><AccessBadge on={u.is_active} /></b></div>
              <div><small>Последний вход</small><b>{u.last_login_at ? fmtDate(u.last_login_at) : "—"}</b></div>
            </div>
            <div className="form-note">Роль и доступ задаются учётной записью в базе и здесь не меняются.</div>
          </div>
          <div className="actions">
            <button type="button" className="btn sm ghost" onClick={() => setAsk(true)}><Icon name="refresh" />Сбросить пароль</button>
            <span className="spacer" /><button type="button" className="btn" onClick={onClose}>Закрыть</button>
          </div>
        </div>
      </Modal>
      {ask && <ConfirmDialog title="Сбросить пароль?" confirm="Сбросить" busy={busy} error={err}
        text={`${u.login} не сможет войти со старым паролем. Новый временный пароль нужно будет передать пользователю.`}
        onCancel={() => { setAsk(false); setErr(null); }} onConfirm={reset} />}
    </>
  );
}

// Временный пароль сгенерировал сервер; после закрытия окна он больше не показывается
function TempPasswordDialog({ u, password, onClose, onCopied, onCopyFailed }: {
  u: AppUser; password: string; onClose: () => void; onCopied: () => void; onCopyFailed: () => void;
}) {
  return (
    <Modal onClose={onClose} outsideClose={false} label="Временный пароль">
      <div className="dialog form-dialog">
        <div className="form-head"><div><h3>Временный пароль</h3><p>{u.login} · {u.person ?? "—"}</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button></div>
        <div className="form-body">
          <div className="pw-box"><code>{password}</code>
            <button type="button" className="btn sm soft" onClick={async () => { try { await navigator.clipboard.writeText(password); onCopied(); } catch { onCopyFailed(); } }}>
              <Icon name="copy" />Скопировать</button></div>
          <div className="form-note">Пользователь сменит пароль при первом входе. После закрытия окна пароль больше не показывается.</div>
        </div>
        <div className="actions"><span className="spacer" /><button type="button" className="btn primary" onClick={onClose} autoFocus>Готово</button></div>
      </div>
    </Modal>
  );
}
