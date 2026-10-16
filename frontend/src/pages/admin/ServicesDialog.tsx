import { Badge, Modal } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { errorText } from "../../api/errors";
import { downParts, SERVICE_ROWS, useServices } from "../../api/admin";

/* ── Состояние сервисов агента (у админа — кнопка «Сервисы» в шапке, как в макете) ── */
export function ServicesButton({ onOpen }: { onOpen: () => void }) {
  const { data } = useServices(true);
  const down = !!data && SERVICE_ROWS.some(([, , parts]) => downParts(data, parts).length);
  return (
    <button type="button" className="btn sm ghost svc-btn" title="Состояние сервисов" onClick={onOpen}
      aria-label={`Сервисы: ${!data ? "проверяем" : down ? "есть недоступные" : "всё работает"}`}>
      <Badge kind={!data ? "muted" : down ? "warn" : "ok"}><span className="svc-label">Сервисы</span></Badge>
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
