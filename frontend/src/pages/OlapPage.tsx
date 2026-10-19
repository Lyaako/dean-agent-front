import { useState } from "react";
import { Page } from "../components/Shell";
import { olap, type Setter } from "./olap/parts";
import { SessionView } from "./olap/SessionView";
import { HeatView } from "./olap/HeatView";
import { RiskView } from "./olap/RiskView";
import { RetakeView } from "./olap/RetakeView";
import { MovesView } from "./olap/MovesView";

/* ═════════ OLAP-АНАЛИЗ ═════════
   Пять срезов макета (mockup/redesign/olap.js): каждый — вопрос деканата и OLAP-операция, которой он отвечается.
   Меры — успеваемость и доли, а не средний балл. Прежние восемь режимов бекенда фронт больше не вызывает */

const OPS: [typeof olap.op, string, string][] = [
  ["session", "Итоги сессии", "Roll-up · Drill-down"],
  ["heat", "Проблемные дисциплины", "Pivot · Slice"],
  ["risk", "Раннее предупреждение", "Dice"],
  ["retake", "Пересдачи", "Roll-up по попыткам"],
  ["moves", "Движение контингента", "Roll-up по времени · Drill-down"],
];

export function OlapPage() {
  const [, rerender] = useState(0);
  const set: Setter = (patch) => { Object.assign(olap, patch); rerender((n) => n + 1); };
  const View = { session: SessionView, heat: HeatView, risk: RiskView, retake: RetakeView, moves: MovesView }[olap.op];
  return (
    <Page title="OLAP-анализ">
      <nav className="olap-ops" aria-label="Срезы">
        {OPS.map(([v, l, t]) => (
          <button key={v} type="button" className="olap-op" aria-pressed={v === olap.op} onClick={() => set({ op: v })}><b>{l}</b><small>{t}</small></button>
        ))}
      </nav>
      <div className="enter olap-body" key={olap.op}><View set={set} /></div>
    </Page>
  );
}
