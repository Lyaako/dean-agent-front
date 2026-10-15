// Даты в API — ISO-строки «YYYY-MM-DD» (или с временем); считаем их в UTC, чтобы не сдвигались поясом
export const D = (s: string) => new Date(s.slice(0, 10) + "T00:00:00Z");
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const mondayOf = (s: string) => addDays(s, -((D(s).getUTCDay() + 6) % 7));
export const weekdayOf = (s: string) => D(s).getUTCDay();   // 0 — воскресенье
export const todayIso = () => { const d = new Date(); return iso(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))); };

export const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
export const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
export const human = (s: string) => `${D(s).getUTCDate()} ${MONTHS[D(s).getUTCMonth()]}`;
export const fmtDate = (s: unknown) => (s ? String(s).slice(0, 10).split("-").reverse().join(".") : "—");
export const fmtDateTime = (s: unknown) => {
  if (!s) return "—";
  const d = new Date(String(s));
  if (Number.isNaN(+d)) return String(s);
  return `${d.toLocaleDateString("ru-RU")} ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
};
export const fmtTime = (s: unknown) => (s ? String(s).slice(0, 5) : "—");
export const fmtNum = (v: unknown, dec = 0) =>
  v == null || v === "" || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};
export const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
export const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
export const tone = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0), 0) % 5;
export const yes = (v: unknown) => (v ? "да" : "—");
