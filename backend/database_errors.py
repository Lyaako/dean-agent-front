"""Public errors for the pinned domain checks; SQL diagnostics stay private."""
import re
import json


def domain_error(exc):
    diagnostic = exc.diag
    message = diagnostic.message_primary or ""
    constraint = diagnostic.constraint_name or ""
    column = diagnostic.column_name or ""
    rules = (
        ("Дата вступления не может быть в прошлом", "effective_date_past", "effective_date", 422),
        ("Invalid signer", "order_signer_invalid", "signed_by", 422),
        ("Нет другого директора или заместителя", "correction_manager_missing", "sheet_id", 409),
        ("дата уже прошла", "order_past_date", "effective_date", 422),
        ("уже прошла — приказ задним числом", "order_past_date", "effective_date", 422),
        ("может подписать только", "order_signer_invalid", "signed_by_id", 422),
        ("уже есть запланированный приказ", "order_pending_exists", "student_id", 409),
        ("по плану изучается", "slot_semester_mismatch", "assignment_id", 422),
        ("Баллы", "points_out_of_scale", "points", 422),
        ("нет оценок у студентов:", "sheet_incomplete", "status", 409),
        ("Нельзя закрыть пустую ведомость", "sheet_incomplete", "status", 409),
        ("более поздняя попытка", "correction_later_attempt", "sheet_id", 409),
        ("изменилась после подачи заявки", "correction_stale", "new_points", 409),
        ("уже завершена, её статус менять нельзя", "request_final", "request_status_id", 409),
        ("Closed grade requires correction", "sheet_closed", "sheet_id", 409),
    )
    code = None
    field = None
    status = 409
    custom={'P6201':('batch_too_large',422),'P6202':('stale_item',409),
        'P6203':('undo_changed',409),'P6204':('undo_unavailable',409)}
    if exc.sqlstate in custom:
        code,status=custom[exc.sqlstate]
        details={}
        try:
            raw=json.loads(diagnostic.message_detail or '{}')
            if isinstance(raw.get('item_id'),int): details['item_id']=raw['item_id']
        except (ValueError,TypeError):
            pass
        return status,code,message,details
    for text, candidate, candidate_field, candidate_status in rules:
        if text in message:
            code, field, status = candidate, candidate_field, candidate_status
            break
    if constraint.endswith("_blank"):
        code, status = "blank_text", 422
        message = "Поле не может быть пустым или содержать пробельные символы по краям"
        field = column or (constraint[len(diagnostic.table_name)+1:-6]
            if diagnostic.table_name and constraint.startswith(diagnostic.table_name+"_") else None)
    elif constraint.startswith("grade_sheet_") and ("date" in constraint or "exam" in constraint):
        code, field, status = "sheet_dates_invalid", "exam_date", 422
        message = "Дата экзамена должна быть от даты выдачи до 366 дней после неё; закрытие — после экзамена"
    elif exc.sqlstate == "23502" and diagnostic.table_name == "academic_order" and column == "signed_by_id":
        code, field, status = "order_signer_invalid", column, 422
        message = "Укажите подписанта приказа"
    elif "Ведомость" in message and ("закрыта" in message or "отменена" in message or "уже закрыта" in message):
        code, field, status = "sheet_closed", "sheet_id", 409
    if code is None:
        return None
    if message == "Closed grade requires correction":
        message = "Закрытую оценку можно изменить только по согласованной заявке на коррекцию"
    details = {"field": field} if field else {}
    if code == "sheet_incomplete":
        names = message.partition("нет оценок у студентов:")[2].strip()
        details["items"] = names.split(", ") if names else []
    # Source messages sometimes append example SQL; return the explanation only.
    message = re.split(r"\s*[—:]\s*(?:CALL\s|fn_\w+\s*\()", message, maxsplit=1, flags=re.I)[0].strip()
    return status, code, message, details
