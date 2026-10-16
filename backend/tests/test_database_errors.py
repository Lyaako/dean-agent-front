"""The public error contract must not expose example SQL from domain triggers."""
from types import SimpleNamespace
import unittest

from backend.database_errors import domain_error


def failure(message, constraint="", column="", table="", state="P0001"):
    return SimpleNamespace(sqlstate=state, diag=SimpleNamespace(message_primary=message,
        constraint_name=constraint, column_name=column, table_name=table))


class DomainErrors(unittest.TestCase):
    def test_example_sql_is_removed_and_incomplete_students_are_structured(self):
        result = domain_error(failure("У студента 5 уже есть запланированный приказ № 8 — отмените: CALL sp_cancel_scheduled_order('8', 5)"))
        self.assertEqual(result[1], "order_pending_exists")
        self.assertNotIn("CALL", result[2])
        result = domain_error(failure("Нельзя закрыть ведомость 4: нет оценок у студентов: Иванов И., Петров П."))
        self.assertEqual(result[3]["items"], ["Иванов И.", "Петров П."])

    def test_constraint_diagnostics_are_replaced_with_public_text(self):
        result = domain_error(failure('SQL internals', 'grade_sheet_exam_date_range', state='23514'))
        self.assertEqual(result[:2], (422, "sheet_dates_invalid"))
        self.assertNotIn('SQL', result[2])
        self.assertEqual(domain_error(failure('details', column='signed_by_id', table='academic_order',state='23502'))[1], 'order_signer_invalid')
        self.assertIsNone(domain_error(failure('unclassified conflict')))

    def test_signer_field_matches_the_column(self):
        for message in ("Invalid signer", "Приказ института 1 может подписать только работающий руководитель этого института"):
            self.assertEqual(domain_error(failure(message))[3], {"field": "signed_by_id"})

    def test_self_decision_check_and_validation_details(self):
        result = domain_error(failure("check", "grade_correction_check5", state="23514"))
        self.assertEqual(result[:2], (403, "correction_self_decision"))
        detail = SimpleNamespace(sqlstate="P6205", diag=SimpleNamespace(message_primary="Комментарий",
            message_detail='{"field": "reason", "max": 500}', constraint_name="", column_name="", table_name=""))
        self.assertEqual(domain_error(detail)[:2] + (domain_error(detail)[3],), (422, "validation_error", {"field": "reason", "max": 500}))
