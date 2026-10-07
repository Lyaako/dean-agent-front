import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ResourceTablePage } from "./ResourceTablePage";
import { REQUEST_COLS } from "./columns";
import type { FormConfig } from "../components/form/RecordDialog";
import { useAuth } from "../auth/AuthProvider";
import { getRow } from "../api/resources";

// Сотрудник деканата, которым является текущий пользователь (если является)
function useMyStaffId() {
  const { me } = useAuth();
  return useQuery({
    queryKey: ["myStaff", me?.person_id],
    enabled: !!me?.person_id,
    staleTime: Infinity,
    queryFn: async () => {
      const emp = await getRow("employee", { person_id: me!.person_id });
      if (!emp) return null;
      return (await getRow("dean_office_staff", { employee_id: emp.employee_id })) ? String(emp.employee_id) : null;
    },
  }).data ?? null;
}

export function RequestsPage() {
  const { role, me } = useAuth();
  const staffId = useMyStaffId();
  const isStudent = role === "student";

  const form = useMemo<FormConfig>(() => ({
    order: ["student_id", "document_type_id", "copies", "purpose", "request_status_id", "processed_by_id"],
    hide: isStudent ? ["student_id", "request_status_id", "processed_by_id"] : [],
    labels: { processed_by_id: "Исполнитель" },
    // Сотрудник взял заявку в работу — исполнителем становится он
    derive: (changed, v) => (changed === "request_status_id" && !v.processed_by_id && staffId ? { processed_by_id: staffId } : {}),
  }), [isStudent, staffId]);

  return (
    <ResourceTablePage id="requests" title="Заявки на справки" view="v_document_queue" table="document_request" keyField="request_id"
      cols={REQUEST_COLS} form={form} newTitle="Новая заявка" rowTitle={(r) => `Заявка № ${r.request_id}: ${r.student}`}
      initial={isStudent && me?.student_id ? { student_id: String(me.student_id) } : undefined} />
  );
}
