import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchMe, login as apiLogin, logout as apiLogout, type Me, type Role } from "../api/auth";
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
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
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
  const entering = useRef(0);

  const reset = useCallback(() => {
    entering.current++;
    setMe(null);
    setFullName(null);
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
    if (attempt !== entering.current || started !== session.revision()) return false;
    setMe(m);
    setStatus("auth");
    setFullName(name);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    session.onExpired(reset);
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
    async login(l, p) { session.clear(); reset(); await apiLogin(l, p); await enter(); },
    async logout() { try { await apiLogout(); } finally { reset(); } },
  }), [status, me, fullName, enter, reset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth вне AuthProvider");
  return v;
}
