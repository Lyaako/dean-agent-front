import { useSyncExternalStore } from "react";

// Тема: светлая, тёмная или как в системе. Выбор хранится в этом браузере
export type ThemePref = "light" | "dark" | "system";

const KEY = "deanery.theme";
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

let pref: ThemePref = "system";
try {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark" || saved === "system") pref = saved;
} catch { /* нет доступа к хранилищу */ }

const apply = () => {
  document.documentElement.dataset.theme = pref === "system" ? (darkQuery.matches ? "dark" : "light") : pref;
};
darkQuery.addEventListener("change", () => { if (pref === "system") apply(); });
apply();

export function setTheme(next: ThemePref) {
  pref = next;
  try { localStorage.setItem(KEY, next); } catch { /* нет доступа к хранилищу */ }
  listeners.forEach((fn) => fn());
  // Плавная смена: браузер растворяет старую картинку в новой; где не поддерживается — просто переключаем
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !reduced) {
    const t = document.startViewTransition(apply);
    t.ready.catch(() => {});
    t.finished.catch(() => {});
  } else apply();
}

export const useThemePref = () =>
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => pref);
