// Приказы по студентам — предметные команды бэкенда (POST /workflows/{name})
export type WfKind = "text" | "textarea" | "date" | "gender" | "group" | "funding" | "leave_reason" | "employee" | "signer";

export interface WfField { name: string; label: string; kind: WfKind; required?: boolean; hint?: string }

export interface WfDef {
  name: string;
  title: string;
  confirm: string;
  /** Подходит ли команда текущему статусу студента */
  when?: (status: string) => boolean;
  fields: WfField[];
}

const ORDER: WfField[] = [
  { name: "order_number", label: "Номер приказа", kind: "text", required: true },
  { name: "signed_by", label: "Подписал", kind: "signer", required: true, hint: "Подписывает директор или заместитель" },
  { name: "effective_date", label: "Вступает в силу", kind: "date", hint: "Пусто — сегодня. Будущая дата — приказ будет запланирован" },
];

const active = (s: string) => s === "Обучается";

export const STUDENT_ACTIONS: WfDef[] = [
  { name: "transfer_student", title: "Перевод в другую группу", confirm: "Перевести", when: active,
    fields: [{ name: "group_name", label: "Новая группа", kind: "group", required: true }, ...ORDER] },
  { name: "grant_academic_leave", title: "Академический отпуск", confirm: "Оформить", when: active,
    fields: [
      { name: "reason", label: "Причина", kind: "leave_reason", required: true },
      { name: "start", label: "Начало", kind: "date", required: true },
      { name: "end", label: "Окончание", kind: "date", required: true },
      ...ORDER.filter((f) => f.name !== "effective_date"),
    ] },
  { name: "return_from_leave", title: "Выход из академического отпуска", confirm: "Оформить", when: (s) => s === "Академический отпуск",
    fields: [{ name: "group_name", label: "Группа", kind: "group", hint: "Пусто — прежняя группа" }, ...ORDER] },
  { name: "expel_student", title: "Отчисление", confirm: "Отчислить", when: (s) => s !== "Отчислен",
    fields: [{ name: "reason", label: "Основание", kind: "textarea", required: true }, ...ORDER] },
  { name: "reinstate_student", title: "Восстановление", confirm: "Восстановить", when: (s) => s === "Отчислен",
    fields: [{ name: "group_name", label: "Группа", kind: "group", required: true }, ...ORDER] },
];

export const ENROLL: WfDef = {
  name: "enroll_student", title: "Зачисление студента", confirm: "Зачислить",
  fields: [
    { name: "last_name", label: "Фамилия", kind: "text", required: true },
    { name: "first_name", label: "Имя", kind: "text", required: true },
    { name: "middle_name", label: "Отчество", kind: "text" },
    { name: "gender", label: "Пол", kind: "gender", required: true },
    { name: "birth_date", label: "Дата рождения", kind: "date", required: true },
    { name: "email", label: "Email", kind: "text" },
    { name: "phone", label: "Телефон", kind: "text" },
    { name: "group_name", label: "Группа", kind: "group", required: true },
    { name: "funding", label: "Основа обучения", kind: "funding", required: true },
    { name: "record_book", label: "Номер зачётной книжки", kind: "text", required: true },
    ...ORDER,
  ],
};
