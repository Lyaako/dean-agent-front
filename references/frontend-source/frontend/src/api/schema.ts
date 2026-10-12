import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { Role } from "./auth";
import { useAuth } from "../auth/AuthProvider";

// GET /api/v1/schema — ресурсы, которые текущий пользователь может читать, с описанием полей и ролей
export interface FieldSpec {
  type: string;
  nullable: boolean;
  default: string | null;
  description?: string | null;
  relation?: { table: string; column: string; on_delete?: string } | null;
}

export type Operation = "read" | "create" | "update" | "delete" | "workflow";

export interface ResourceSpec {
  kind: "table" | "view";
  key: string[];
  fields: Record<string, FieldSpec>;
  read_fields: string[];
  write_fields: string[];
  read_roles: Role[];
  write_roles: Role[];
  operations: Operation[];
  operation_roles: Partial<Record<Operation, Role[]>>;
  workflow_only: string[];
}

export type Schema = Record<string, ResourceSpec>;

export function useSchema() {
  return useQuery({
    queryKey: ["schema"],
    queryFn: async () => (await api<{ version: number; resources: Schema }>("/schema")).resources,
    staleTime: Infinity,
  });
}

// Разрешена ли операция над ресурсом текущей роли (бэкенд всё равно перепроверит)
export function useCan() {
  const { role } = useAuth();
  const { data: schema } = useSchema();
  return (resource: string, op: Operation) => {
    const spec = schema?.[resource];
    return !!(spec && role && spec.operations.includes(op) && spec.operation_roles[op]?.includes(role));
  };
}

// Короткая подпись поля из описания в БД: «Шифр группы: ИДБ-24-11 — …» → «Шифр группы»
export function fieldLabel(spec: FieldSpec | undefined, name: string) {
  const d = spec?.description?.trim();
  if (!d) return name;
  const cut = d.split(/[:(]| — | - |; /)[0].trim();
  return cut || d;
}

// Подсказка — остаток описания после подписи
export function fieldHint(spec: FieldSpec | undefined) {
  const d = spec?.description?.trim() ?? "";
  const label = fieldLabel(spec, "");
  const rest = d.slice(label.length).replace(/^[\s:—\-;]+/, "").replace(/^\((.*)\)$/, "$1").trim();
  // Технические пометки схемы («1:1», «M:N») пользователю не нужны
  if (/^\d+\s*:\s*[\dNMnm]+$/.test(rest)) return undefined;
  return rest || undefined;
}
