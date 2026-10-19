// Вид результата: баллы 25–54, «не аттестован» (баллов нет, не неявка) или неявка — общее для ведомости и заявки на исправление
export type Mode = "points" | "na" | "absent";
export const RES_MODES: [Mode, string][] = [["points", "Баллы"], ["na", "Не аттестован"], ["absent", "Неявка"]];

export const ptsError = (pts: string) => {
  if (pts === "") return undefined;
  const p = Number(pts);
  return !Number.isInteger(p) || p < 25 || p > 54 ? "Баллы — от 25 до 54" : undefined;
};
