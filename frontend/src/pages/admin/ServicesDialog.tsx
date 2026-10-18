import { Badge, Modal } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errorText } from "../../api/errors";
import { downParts, SERVICE_ROWS, useServices } from "../../api/admin";

/* ── Состояние сервисов агента (у админа — пункт «Сервисы» в меню профиля) ── */
/** Есть ли недоступные сервисы: undefined — ещё проверяем */
export function useServicesDown(enabled: boolean): boolean | undefined {
  const { data } = useServices(enabled);
  return data ? SERVICE_ROWS.some(([, , parts]) => downParts(data, parts).length > 0) : undefined;
}

export function ServicesMenuItem({ onOpen }: { onOpen: () => void }) {
  const down = useServicesDown(true);
  return (
    <button role="menuitem" className="menu-item" onClick={onOpen}>
      <Icon name="grid" /><span>Сервисы</span>
      <span className="menu-side"><Badge kind={down == null ? "muted" : down ? "warn" : "ok"}>{down == null ? "проверяем" : down ? "есть сбои" : "работают"}</Badge></span>
    </button>
  );
}

export function ServicesDialog({ onClose }: { onClose: () => void }) {
  const { data, error, isLoading } = useServices(true);
  const modelDown = !!data && downParts(data, SERVICE_ROWS[0][2]).length > 0;
  return (
    <Modal onClose={onClose} label="Сервисы">
      <div className="dialog form-dialog ref-dialog">
        <div className="form-head"><div><h3>Сервисы</h3><p>Состояние сервисов агента</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}><Icon name="x" /></button></div>
        <div className="form-body">
          {error ? <p className="form-error">{errorText(error)}</p> : isLoading ? <div className="skel" style={{ height: 120 }} /> : (
            <div className="ref-list">
              {SERVICE_ROWS.map(([id, name, parts]) => {
                const down = downParts(data, parts);
                return (
                  <div key={id} className="ref-row" title={down.join("; ") || undefined}>
                    <b>{name}</b>
                    <span className="ref-side">{down.length > 0 && <small>{down.join(", ")}</small>}
                      {down.length ? <Badge kind="bad">недоступен</Badge> : <Badge kind="ok">работает</Badge>}</span>
                  </div>
                );
              })}
            </div>
          )}
          {modelDown && <div className="form-note">Пока модель недоступна, чат у всех пользователей не отправляет сообщения. Таблицы и формы работают.</div>}
        </div>
        <div className="actions"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Закрыть</button></div>
      </div>
    </Modal>
  );
}
