import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/styles.css";
import "./styles/app.css";
import "./styles/extra.css";
import "./lib/theme";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { MustChangeDialog } from "./auth/AccountDialog";
import { ToastProvider } from "./components/ui";
import { Shell } from "./components/Shell";
import { StudentsPage } from "./pages/students/StudentsPage";
import { GroupsPage } from "./pages/GroupsPage";
import { SchedulePage } from "./pages/schedule/SchedulePage";
import { WorksPage } from "./pages/WorksPage";
import { RequestsPage } from "./pages/RequestsPage";
import { PracticePage } from "./pages/PracticePage";
import { EmployeesPage } from "./pages/EmployeesPage";
import { OlapPage } from "./pages/OlapPage";
import { SheetsPage } from "./pages/sheets/SheetsPage";
import { AttendancePage } from "./pages/attendance/AttendancePage";
import { AuditPage } from "./pages/AuditPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function App() {
  const { status, mustChange } = useAuth();
  if (status === "loading") return <div className="splash"><span className="orb xl" /></div>;
  if (status === "anon") return <LoginPage />;
  // Пароль сброшен администратором: поверх экрана входа — окно смены, дальше не пускаем
  if (mustChange) return <><LoginPage /><MustChangeDialog /></>;
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/groups" element={<GroupsPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/sheets" element={<SheetsPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/works" element={<WorksPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/practice" element={<PracticePage />} />
        <Route path="/employees" element={<EmployeesPage />} />
        <Route path="/olap" element={<OlapPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/students" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
