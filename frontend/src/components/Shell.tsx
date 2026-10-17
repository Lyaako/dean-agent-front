import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { Icon } from "./Icon";
import { TABS, type TabDef } from "../pages/tabs";
import { useSchema } from "../api/schema";
import { useAuth } from "../auth/AuthProvider";
import { ROLE_NAME } from "../api/auth";
import { human, initials, tone, todayIso } from "../lib/format";
import { ChatBar } from "../chat/ChatBar";
import { AccountDialog } from "../auth/AccountDialog";
import { ServicesButton, ServicesDialog } from "../pages/admin/ServicesDialog";

const WD_FULL = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];

// Вкладки, которые роль может читать
export function useVisibleTabs(): TabDef[] {
  const { data: schema } = useSchema();
  const { role } = useAuth();
  return TABS.filter((t) => (!t.view || !schema || schema[t.view]) && (!t.roles || (role && t.roles.includes(role))));
}

export function Shell() {
  const { me } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  // Адрес чужой вкладки (остался от прошлой учётки или набран вручную) — на первую вкладку роли
  const tabs = useVisibleTabs();
  const { pathname } = useLocation();
  const foreign = tabs.length > 0 && !tabs.some((t) => t.path === pathname);
  return (
    <div className={`app${scrolled ? " scrolled" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <span className="orb logo-orb" aria-hidden="true" />
          <b>Деканат</b>
        </div>
        <ChatBar key={me?.user_id} open={chatOpen} setOpen={setChatOpen} />
        <Me />
      </header>
      <div className={`scrim${chatOpen ? " show" : ""}`} onClick={() => setChatOpen(false)} />
      <main className="content" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 4)}>
        <div className="page">{foreign ? <Navigate to={tabs[0].path} replace /> : <Outlet />}</div>
      </main>
      <TabBar />
    </div>
  );
}

function Me() {
  const { me, role, fullName, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState(false);
  const [services, setServices] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const today = todayIso();
  const name = fullName || me?.login || "";
  return (
    <div className="me" ref={ref}>
      {/* У админа на месте даты — состояние сервисов агента */}
      {role === "admin" ? <ServicesButton onOpen={() => setServices(true)} />
        : <div className="when"><b>{WD_FULL[new Date().getDay()]}, {human(today)}</b></div>}
      <button className={`avatar t${tone(name)} avatar-btn`} title={`${name} — ${role ? ROLE_NAME[role] : ""}`}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {initials(name)}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head"><b>{name}</b><small>{role ? ROLE_NAME[role] : ""} · {me?.login}</small></div>
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); setAccount(true); }}>
            <Icon name="users" /><span>Личный кабинет</span>
          </button>
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); logout(); }}>
            <Icon name="logout" /><span>Выйти</span>
          </button>
        </div>
      )}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
      {services && <ServicesDialog onClose={() => setServices(false)} />}
    </div>
  );
}

function TabBar() {
  const tabs = useVisibleTabs();
  const { pathname } = useLocation();
  const i = Math.max(0, tabs.findIndex((t) => pathname.startsWith(t.path)));
  return (
    <nav className="tabbar" aria-label="Разделы">
      <div className="tabs" role="tablist" style={{ ["--n" as string]: tabs.length, ["--i" as string]: i }}>
        <span className="tab-ind" aria-hidden="true" />
        {tabs.map((t) => (
          <NavLink key={t.id} to={t.path} className="tab" role="tab" title={t.title}
            aria-selected={pathname.startsWith(t.path)}>
            <Icon name={t.icon} /><span>{t.short || t.title}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

// Страница вкладки: заголовок и блоки, которые появляются по очереди
export function Page({ title, head, children }: { title: string; head?: ReactNode; children: ReactNode[] | ReactNode }) {
  const parts = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return (
    <div className="view">
      <div className="rise" style={{ ["--i" as string]: 0 }}>
        <header className="page-head"><div className="titles"><h1>{title}</h1></div>{head}</header>
      </div>
      {parts.map((p, i) => <div key={i} className="rise" style={{ ["--i" as string]: i + 1 }}>{p}</div>)}
    </div>
  );
}
