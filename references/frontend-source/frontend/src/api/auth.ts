import { API_BASE, api, readError, session } from "./client";

export type Role = "admin" | "director" | "dean_staff" | "teacher" | "student";

export interface Me {
  user_id: number;
  login: string;
  roles: Role[];
  person_id: number | null;
  institute_ids: number[];
  student_id: number | null;
  teacher_id: number | null;
}

export const ROLE_NAME: Record<Role, string> = {
  admin: "Администратор",
  director: "Директор института",
  dean_staff: "Сотрудник деканата",
  teacher: "Преподаватель",
  student: "Студент",
};

export const STAFF_ROLES: Role[] = ["admin", "director", "dean_staff"];

export async function login(loginName: string, password: string) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: loginName, password }),
  });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  session.start(body.access_token, body.csrf_token);
}

export const fetchMe = () => api<Me>("/auth/me");

export async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } finally { session.clear(); }
}
