// Приказы: подписанты и отмена запланированного приказа студента (docs/API.md, решения Р5 и Р7)
import { api, newKey } from "./client";

export interface Signer { employee_id: number; person: string; position: string; is_director: boolean }

export const getSigners = async (instituteId: number) =>
  (await api<{ items: Signer[] }>("/orders/signers", { query: { institute_id: instituteId } })).items;

// Отмена будущего неисполненного приказа для студента. Ключ идемпотентности — на одну попытку отмены
export const cancelStudentOrder = (orderNumber: string, studentId: number, key: string = newKey()) =>
  api(`/orders/${encodeURIComponent(orderNumber)}/students/${studentId}/cancel`, { method: "POST", json: {}, headers: { "Idempotency-Key": key } });
