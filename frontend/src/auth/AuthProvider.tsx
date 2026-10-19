import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { changePassword as apiChangePassword, fetchMe, login as apiLogin, logout as apiLogout, logoutAll as apiLogoutAll, type Me, type Role } from "../api/auth";
import { api, refreshSession, session } from "../api/client";
import { clearChatRecovery } from "../chat/store/recovery";
import { clearTableState } from "../components/table/useTableState";
import { clearScheduleState } from "../pages/schedule/SchedulePage";

type Status = "loading" | "anon" | "auth";

interface AuthValue {
  status: Status;
  me: Me | null;
  role: Role | null;
  fullName: string | null;
  /** Пароль сброшен администратором: до смены работа недоступна */
  mustChange: boolean;
  /** Временный пароль, введённый при входе (только в памяти этой вкладки) */
  tempPassword(): string | null;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// ФИО для шапки: из person, если у пользователя он есть
async function loadName(me: Me): Promise<string | null> {
  if (!me.person_id) return null;
  try {
    const page = await api<{ items: Record<string, string | null>[] }>("/resources/person", { query: { person_id: me.person_id, limit: 1 } });
    const p = page.items[0];
    return p ? [p.last_name, p.first_name, p.middle_name].filter(Boolean).join(" ") : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [forced, setForced] = useState(false);
  const entering = useRef(0);
  const temp = useRef<string | null>(null);

  const reset = useCallback(() => {
    entering.current++;
    setMe(null);
    setFullName(null);
    setForced(false);
    temp.current = null;
    setStatus("anon");
    qc.clear();
    clearChatRecovery();
    clearTableState();
    clearScheduleState();
  }, [qc]);

  const enter = useCallback(async () => {
    const attempt = entering.current;
    const started = session.revision();
    const m = await fetchMe();
    const name = await loadName(m);
    if (attempt !== entering.current || started !== session.revision()) return null;
    setMe(m);
    setStatus("auth");
    setFullName(name);
    return m;
  }, []);

  useEffect(() => {
    let cancelled = false;
    session.onExpired(reset);
    // Любой запрос получил password_change_required (например, админ сбросил пароль, пока вкладка открыта)
    session.onPasswordRequired(() => setForced(true));
    // Токен уже в памяти (повторное монтирование) — просто проверяем его; после перезагрузки страницы — обновляем по cookie.
    // Лишнее обновление опасно: если страница уйдёт до ответа, новая cookie потеряется и бэкенд закроет сессию.
    (async () => {
      if (session.hasAccess() || (session.hasCsrf() && (await refreshSession()))) {
        if (cancelled) return;
        try { if (await enter()) return; } catch { /* упадём на вход */ }
      }
      if (!cancelled) setStatus("anon");
    })();
    return () => { cancelled = true; };
  }, [enter, reset]);

  const value = useMemo<AuthValue>(() => ({
    status, me, fullName,
    role: me?.roles[0] ?? null,
    mustChange: forced || !!me?.must_change_password,
    tempPassword: () => temp.current,
    async login(l, p) {
      session.clear(); reset(); await apiLogin(l, p);
      // Пароль держим в памяти, только если это временный пароль: им подтверждается обязательная смена
      temp.current = p;
      const m = await enter();
      if (!m?.must_change_password) temp.current = null;
    },
    async logout() { try { await apiLogout(); } finally { reset(); } },
    async logoutAll() { try { await apiLogoutAll(); } finally { reset(); } },
    async changePassword(current, next) {
      await apiChangePassword(current, next);
      temp.current = null;
      setForced(false);
      // После обязательной смены заново читаем учётную запись и ФИО — до неё они были закрыты
      await enter();
    },
  }), [status, me, fullName, forced, enter, reset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth вне AuthProvider");
  return v;
}
