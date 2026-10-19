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
  /** Вход по временному паролю после сброса: до смены доступны только me, password и logout */
  must_change_password: boolean;
}

// Личные данные из GET /me/profile: у сотрудника — работа, у студента — учёба
export interface Profile {
  role: Role;
  email?: string | null;
  phone?: string | null;
  unit?: string | null;
  position?: string | null;
  hire_date?: string | null;
  employment_rate?: number | null;
  personnel_number?: string | null;
  group?: string | null;
  course?: number | null;
  status?: string | null;
  funding?: string | null;
  record_book_number?: string | null;
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
export const fetchProfile = () => api<Profile>("/me/profile");

// Остальные сеансы бэкенд закрывает, текущий остаётся
export const changePassword = (current_password: string, new_password: string) =>
  api("/auth/password", { method: "POST", json: { current_password, new_password } });

export async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } finally { session.clear(); }
}

export async function logoutAll() {
  try { await api("/auth/logout-all", { method: "POST" }); } finally { session.clear(); }
}
