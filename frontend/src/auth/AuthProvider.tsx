import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchMe, login as apiLogin, logout as apiLogout, type Me, type Role } from "../api/auth";
import { api, refreshSession, session } from "../api/client";

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

  const reset = useCallback(() => {
    setMe(null);
    setFullName(null);
    setStatus("anon");
    qc.clear();
  }, [qc]);

  const enter = useCallback(async () => {
    const m = await fetchMe();
    setMe(m);
    setStatus("auth");
    setFullName(await loadName(m));
  }, []);

  useEffect(() => {
    session.onExpired(reset);
    // После перезагрузки страницы: пробуем обновить токен по cookie
    (async () => {
      if (session.hasCsrf() && (await refreshSession())) {
        try { await enter(); return; } catch { /* упадём на вход */ }
      }
      setStatus("anon");
    })();
  }, [enter, reset]);

  const value = useMemo<AuthValue>(() => ({
    status, me, fullName,
    role: me?.roles[0] ?? null,
    async login(l, p) { await apiLogin(l, p); await enter(); },
    async logout() { try { await apiLogout(); } finally { reset(); } },
  }), [status, me, fullName, enter, reset]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth вне AuthProvider");
  return v;
}
