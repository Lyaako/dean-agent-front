import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, CodedText, ErrorNote, Modal, Seg, useToast } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { useAuth } from "../../auth/AuthProvider";
import { useCan } from "../../api/schema";
import { ApiError } from "../../api/client";
import { errorCode, errorField, errorItems, errorText, requestIdOf } from "../../api/errors";
import { addDays, fmtDate, plural, todayIso } from "../../lib/format";
import {
  attemptsOf, closeSheet, createRetake, KIND_NAME, resultText, retakeCandidates, saveGrade, STAGE_NAME, STATUS_NAME,
  useGradesOf, useRoster, useScale, type RosterRow, type Sheet,
} from "../../api/sheets";

// Вид результата в строке: баллы 25–54, «не аттестован» (баллов нет, не неявка) или неявка.
// В открытой ведомости строка без баллов и без отметки — результат ещё не выставлен (строки grade нет)
type Mode = "points" | "na" | "absent";
const RES_MODES: [Mode, string][] = [["points", "Баллы"], ["na", "Не аттестован"], ["absent", "Неявка"]];

interface Draft { student_id: number; student: string; pts: string; absent: boolean; na: boolean }

const fromRow = (r: RosterRow): Draft => ({
  student_id: r.student_id, student: r.student,
  pts: r.grade?.points == null ? "" : String(r.grade.points),
  absent: !!r.grade?.is_absent,
  na: !!r.grade && r.grade.points == null && !r.grade.is_absent,
});
const modeOf = (r: Draft): Mode => (r.absent ? "absent" : r.pts !== "" ? "points" : r.na ? "na" : "points");
const hasResult = (r: Draft) => r.pts !== "" || r.absent || r.na;
const same = (a: Draft, b: Draft) => a.pts === b.pts && a.absent === b.absent && a.na === b.na;
const ptsError = (pts: string) => {
  if (pts === "") return undefined;
  const p = Number(pts);
  return !Number.isInteger(p) || p < 25 || p > 54 ? "Баллы — от 25 до 54" : undefined;
};

interface Props { sheet: Sheet; all: Sheet[]; onClose: () => void; onOpen: (sheetId: number) => void }

export function SheetDialog({ sheet, all, onClose, onOpen }: Props) {
  const { me, role } = useAuth();
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const scale = useScale();
  const rosterQ = useRoster(sheet.sheet_id);
  const roster = rosterQ.data;
  // Попытки того же этапа нужны только закрытой основной ведомости — для кнопки «Создать ведомость пересдачи»
  const forRetake = sheet.status !== "open" && sheet.sheet_kind === "main" && can("grade_sheet", "create");
  const attempts = useMemo(() => (forRetake ? attemptsOf(sheet, all) : []), [forRetake, sheet, all]);
  const attemptGrades = useGradesOf(attempts.map((a) => a.sheet_id));
  const attemptData = attempts.map((a, i) => ({ sheet: a, grades: attemptGrades[i]?.data }));
  const loadError = rosterQ.error || attemptGrades.find((q) => q.error)?.error;

  const isOpen = sheet.status === "open";
  const sheetStaff = can("grade_sheet", "update");
  const edit = isOpen && can("grade", "update") && (role !== "teacher" || sheet.examiner_id === me?.teacher_id);
  const retake = forRetake && roster ? retakeCandidates(roster, attemptData) : [];

  // Черновик строится один раз, когда известен состав; после сохранения база обновляется, черновик остаётся
  const [draft, setDraft] = useState<Draft[] | null>(null);
  useEffect(() => { if (!draft && roster) setDraft(roster.map(fromRow)); }, [draft, roster]);
  const base = useMemo(() => new Map((roster ?? []).map((r) => [r.student_id, r])), [roster]);
  const changed = (draft ?? []).filter((d) => { const r = base.get(d.student_id); return !r || !same(d, fromRow(r)); });

  const [errs, setErrs] = useState<Record<number, ReactNode>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);

  const patch = (id: number, p: Partial<Draft>) => {
    setDraft((ds) => ds && ds.map((d) => (d.student_id === id ? { ...d, ...p } : d)));
    setErrs(({ [id]: _, ...rest }) => rest);
    setFailure(null);
  };
  const setMode = (d: Draft, mode: Mode) => patch(d.student_id, { absent: mode === "absent", na: mode === "na", pts: mode === "points" ? d.pts : "" });

  // Проверка до отправки: шкала баллов; выставленный результат удалить нельзя — только заменить
  function validate() {
    const e: Record<number, ReactNode> = {};
    for (const d of draft ?? []) {
      const pe = ptsError(d.pts);
      if (pe) e[d.student_id] = pe;
      else if (!hasResult(d) && base.get(d.student_id)?.grade) e[d.student_id] = "Введите баллы";
    }
    setErrs(e);
    return !Object.keys(e).length;
  }

  // Каждая строка — отдельная запись grade; ошибку базы показываем у баллов этой строки
  async function save(): Promise<boolean> {
    if (!changed.length) return true;
    const e: Record<number, ReactNode> = {};
    let ok = 0;
    for (const d of changed.filter(hasResult)) {
      try {
        await saveGrade(sheet.sheet_id, d.student_id, base.get(d.student_id)?.grade?.grade_id ?? null, d.pts === "" ? null : Number(d.pts), d.absent);
        ok++;
      } catch (ex) {
        if (ex instanceof ApiError && ex.status === 401) throw ex;
        e[d.student_id] = <CodedText text={errorText(ex, "grade")} code={errorCode(ex)} />;
      }
    }
    await qc.invalidateQueries({ queryKey: ["roster", sheet.sheet_id] });
    setErrs(e);
    const failed = Object.keys(e).length;
    if (failed) toast(ok ? `Сохранено ${ok} из ${ok + failed} — проверьте отмеченные строки` : "Баллы не сохранены — проверьте отмеченные строки", true);
    return !failed;
  }

  async function onSave() {
    if (busy || !validate()) return;
    setBusy(true); setFailure(null);
    try {
      if (await save()) { toast("Баллы сохранены"); onClose(); }
    } catch (ex) { setFailure(ex); } finally { setBusy(false); }
  }

  async function onRetake() {
    if (busy) return;
    setBusy(true); setFailure(null);
    try {
      const created = await createRetake(sheet, all);
      await qc.invalidateQueries({ queryKey: ["sheets"] });
      toast(`Создана ведомость пересдачи ${String(created.sheet_number)}`);
      onOpen(Number(created.sheet_id));
    } catch (ex) { setFailure(ex); } finally { setBusy(false); }
  }

  const row = (d: Draft) => {
    const pe = ptsError(d.pts);
    const [t, k] = pe ? ["—", ""] : resultText(sheet, scale.data, d.pts === "" ? null : Number(d.pts), d.absent, d.na || !isOpen);
    const res = k ? <Badge kind={k}>{t}</Badge> : t;
    if (!edit) return (
      <tr key={d.student_id}><td>{d.student}</td><td>{d.pts || "—"}</td><td>{d.absent ? "да" : "—"}</td><td>{res}</td></tr>
    );
    const err = errs[d.student_id];
    return (
      <tr key={d.student_id}>
        <td>{d.student}</td>
        <td><Seg value={modeOf(d)} options={RES_MODES} onChange={(m) => setMode(d, m)} disabled={busy} label={`Результат: ${d.student}`} /></td>
        <td>
          <div className={err ? "form-field invalid" : undefined}>
            <input className="text-input pts" type="number" min={25} max={54} step={1} inputMode="numeric" aria-label={`Баллы: ${d.student}`}
              value={d.pts} disabled={d.absent || d.na || busy}
              onChange={(e) => patch(d.student_id, { pts: e.target.value.trim() })}
              // Ошибка у поля — когда ввод закончен, а не на каждой цифре
              onBlur={() => { const pe2 = ptsError(d.pts); if (pe2) setErrs((x) => ({ ...x, [d.student_id]: pe2 })); }} />
            {err && <small className="field-error" role="alert">{err}</small>}
          </div>
        </td>
        <td>{res}</td>
      </tr>
    );
  };

  const kind = KIND_NAME[sheet.sheet_kind].toLowerCase();
  return (
    <>
      <Modal onClose={() => { if (!busy) onClose(); }} outsideClose={!changed.length} label={`Ведомость ${sheet.sheet_number}`}>
        <div className={`dialog form-dialog sheet-dialog${edit ? " sheet-edit" : ""}`}>
          <div className="form-head">
            <div><h3>{sheet.discipline}</h3><p>{sheet.group_name} · {sheet.semester} семестр · {STAGE_NAME[sheet.stage]} · {kind} ведомость {sheet.sheet_number}</p></div>
            <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose} disabled={busy}><Icon name="x" /></button>
          </div>
          <div className="form-body">
            <div className="sheet-meta">
              <Badge kind={isOpen ? "warn" : "muted"}>{STATUS_NAME[sheet.status]}</Badge>
              <span><Icon name="users" />{sheet.examiner}</span>
              <span><Icon name="calendar" />{sheet.exam_date ? fmtDate(sheet.exam_date) : "дата не назначена"}</span>
              <span>{sheet.control_type}</span>
            </div>
            {isOpen && !edit && role === "teacher" && <div className="form-note">Ведомость ведёт {sheet.examiner} — вы можете только посмотреть.</div>}
            {loadError ? <ErrorNote text={errorText(loadError)} requestId={requestIdOf(loadError)} />
              : !draft ? <p className="hint">Загружаем…</p>
              : !draft.length ? <div className="form-note">В ведомости пока нет студентов.</div>
              : (
                <div className="sheet-wrap">
                  <table className="sheet-table">
                    <thead><tr><th>Студент</th>{edit ? <><th>Результат</th><th>Баллы</th><th>Оценка</th></> : <><th>Баллы</th><th>Неявка</th><th>Результат</th></>}</tr></thead>
                    <tbody>{draft.map(row)}</tbody>
                  </table>
                </div>
              )}
            <p className="hint">25–34 — удовлетворительно, 35–44 — хорошо, 45–54 — отлично; ниже 25 баллов ставится «не аттестован».</p>
            {failure != null && <ErrorNote text={errorText(failure)} requestId={requestIdOf(failure)} code={errorCode(failure)} />}
          </div>
          <div className="actions">
            {retake.length > 0 && <button type="button" className="btn sm ghost" onClick={onRetake} disabled={busy}><Icon name="plus" />Создать ведомость пересдачи</button>}
            <span className="spacer" />
            <button type="button" className="btn" onClick={onClose} disabled={busy}>{edit ? "Отменить" : "Закрыть"}</button>
            {edit && sheetStaff && <button type="button" className="btn" disabled={busy || !draft} onClick={() => { if (validate()) setClosing(true); }}>Закрыть ведомость</button>}
            {edit && <button type="button" className="btn primary" onClick={onSave} disabled={busy || !changed.length}>{busy ? "Сохраняем…" : "Сохранить"}</button>}
          </div>
        </div>
      </Modal>
      {closing && draft && (
        <CloseSheetDialog sheet={sheet} missing={draft.filter((d) => !hasResult(d)).map((d) => d.student)}
          onCancel={() => setClosing(false)}
          onConfirm={async (examDate) => {
            // Сначала сохраняем выставленное в окне, потом закрываем
            if (!(await save())) { setClosing(false); return false; }
            await closeSheet(sheet.sheet_id, examDate);
            // Закрытие меняет и составы других пересдач этого этапа
            await Promise.all([qc.invalidateQueries({ queryKey: ["sheets"] }), qc.invalidateQueries({ queryKey: ["roster"] })]);
            toast("Ведомость закрыта");
            onClose();
            return true;
          }} />
      )}
    </>
  );
}

/* ── Закрытие ведомости: дата экзамена и список студентов без результата. Закрывают деканат, директор, админ ── */
// Закрыть можно, когда результат есть у всех в составе (как в макете; состав пересдачи — несдавшие этой группы, /roster)
function CloseSheetDialog({ sheet, missing, onCancel, onConfirm }: {
  sheet: Sheet; missing: string[]; onCancel: () => void; onConfirm: (examDate: string) => Promise<boolean>;
}) {
  // Дата экзамена — не раньше выдачи и не позже чем через 366 дней; ведомость закрывается сегодня, поэтому экзамен — не позже сегодня
  const today = todayIso();
  const min = sheet.issue_date, max = [addDays(sheet.issue_date, 366), today].sort()[0];
  const [date, setDate] = useState(sheet.exam_date && sheet.exam_date >= min && sheet.exam_date <= max ? sheet.exam_date : max);
  const [err, setErr] = useState<ReactNode>(null);
  const [listErr, setListErr] = useState<{ node: ReactNode; items: string[] } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(null); setListErr(null); setFailure(null);
    if (date < min || date > max) { setErr(`Дата экзамена — с ${fmtDate(min)} по ${fmtDate(max)}`); return; }
    setBusy(true);
    try {
      await onConfirm(date);
    } catch (ex) {
      // Ошибки базы: даты — под датой, нет результата — под списком
      const coded = <CodedText text={errorText(ex)} code={errorCode(ex)} />;
      if (errorField(ex, ["exam_date"])) setErr(coded);
      else if (ex instanceof ApiError && ex.code === "sheet_incomplete") setListErr({ node: coded, items: errorItems(ex) });
      else setFailure(ex);
    } finally { setBusy(false); }
  }

  return (
    <Modal onClose={() => { if (!busy) onCancel(); }} label="Закрыть ведомость">
      <div className="dialog form-dialog">
        <div className="form-head">
          <div><h3>Закрыть ведомость</h3><p>{sheet.sheet_number} · {sheet.discipline} · {sheet.group_name}</p></div>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onCancel} disabled={busy}><Icon name="x" /></button>
        </div>
        <div className="form-body">
          <div className={`field form-field${err ? " invalid" : ""}`}>
            <label htmlFor="cs-date">Дата экзамена</label>
            <input id="cs-date" className="text-input" type="date" min={min} max={max} value={date} disabled={busy}
              onChange={(e) => { setDate(e.target.value); setErr(null); setListErr(null); }} />
            {err ? <small className="field-error" role="alert">{err}</small>
              : <small className="hint">С {fmtDate(min)} по {fmtDate(max)}: не раньше выдачи ведомости и не позже сегодняшнего дня</small>}
          </div>
          {missing.length ? (
            <div className="form-note">Нет результата у {missing.length} {plural(missing.length, "студента", "студентов", "студентов")} — выставьте баллы, «не аттестован» или неявку:
              <ul className="effects">{missing.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          ) : <div className="form-note">Результат есть у всех студентов. После закрытия результаты не меняются — только через заявку на исправление.</div>}
          {listErr && <>
            <small className="field-error" role="alert">{listErr.node}</small>
            {listErr.items.length > 0 && <ul className="effects">{listErr.items.map((s) => <li key={s}>{s}</li>)}</ul>}
          </>}
          {failure != null && <ErrorNote text={errorText(failure)} requestId={requestIdOf(failure)} code={errorCode(failure)} />}
        </div>
        <div className="actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>Отменить</button>
          <button type="button" className="btn primary" onClick={submit} disabled={missing.length > 0 || !date || busy}>{busy ? "Закрываем…" : "Закрыть"}</button>
        </div>
      </div>
    </Modal>
  );
}
