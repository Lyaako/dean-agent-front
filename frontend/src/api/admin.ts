// Администратор: учётные записи (только чтение), сброс пароля, состояние сервисов
import { useQuery } from "@tanstack/react-query";
import { api, newKey } from "./client";
import type { Role } from "./auth";

export interface AppUser { user_id: number; login: string; person: string | null; role: Role; is_active: boolean; last_login_at: string | null }

// Сброс: сервер генерирует временный пароль и показывает его ровно один раз; все сеансы пользователя закрываются
export const resetPassword = (userId: number, key: string = newKey()) =>
  api<{ user_id: number; temporary_password: string; must_change_password: true }>(`/admin/users/${userId}/reset-password`,
    { method: "POST", json: {}, headers: { "Idempotency-Key": key } });

// Состояние сервисов агента (GET /agent/capabilities → services, только для admin)
export type ServiceState = "ready" | "unavailable" | "uncalibrated" | "missing" | string;
export interface Services { model?: ServiceState; calibration?: ServiceState; embedding?: ServiceState; index?: ServiceState;
  agent_worker?: ServiceState; file_worker?: ServiceState; knowledge_worker?: ServiceState; order_worker?: ServiceState }

export const useServices = (enabled: boolean) => useQuery({
  queryKey: ["services"], enabled, refetchInterval: 60_000,
  queryFn: async () => (await api<{ services?: Services }>("/agent/capabilities")).services ?? {},
});

// Четыре строки макета (chat.js, SERVICES) из восьми компонентов бекенда: сервис работает, если готовы все его части
export const SERVICE_ROWS: [string, string, (keyof Services)[]][] = [
  ["model", "Модель", ["model", "calibration", "agent_worker"]],
  ["search", "Поиск по нормативам", ["embedding", "index", "knowledge_worker"]],
  ["files", "Обработка файлов", ["file_worker"]],
  ["orders", "Исполнитель приказов", ["order_worker"]],
];
const PART_NAME: Record<string, string> = { model: "модель", calibration: "калибровка", agent_worker: "обработчик агента", embedding: "эмбеддинги",
  index: "индекс", knowledge_worker: "обработчик нормативов", file_worker: "обработчик файлов", order_worker: "обработчик приказов" };
const STATE_NAME: Record<string, string> = { unavailable: "недоступен", uncalibrated: "не откалиброван", missing: "нет" };

/** Неготовые части сервиса: «калибровка — не откалиброван» и т. п.; пусто — работает */
export const downParts = (s: Services | undefined, parts: (keyof Services)[]) =>
  parts.filter((p) => s?.[p] !== "ready").map((p) => `${PART_NAME[p]} — ${STATE_NAME[String(s?.[p])] ?? s?.[p] ?? "нет данных"}`);
