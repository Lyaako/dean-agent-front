"""Check the API boundaries before wiring database and agent handlers."""

from datetime import date, datetime, time, timezone
from decimal import Decimal
import unittest

from pydantic import ValidationError

from backend.contracts import (
    ChatTitle, ErrorResponse, GradeCorrectionRequest, Job, Me, ProposalSubmitRequest,
    ResourceField, ResourcePage, ResourceSpec, SchemaResponse, SessionInfo,
    StoredRunEvent, StopResponse,
)


class ContractTests(unittest.TestCase):
    def resource(self, **changes):
        return {
            "kind": "table", "key": ["order_id", "student_id"],
            "fields": {
                "order_id": {"type": "integer", "nullable": False, "default": None,
                             "relation": {"table": "academic_order", "column": "order_id", "on_delete": "RESTRICT"}},
                "student_id": {"type": "integer", "nullable": False, "default": None},
                "reason": {"type": "character varying(500)", "nullable": True, "default": None},
            },
            "read_fields": ["order_id", "student_id", "reason"], "write_fields": [],
            "read_roles": ["dean_staff"], "write_roles": [], "operations": ["read"],
            "operation_roles": {"read": ["dean_staff"]}, "workflow_only": [],
        } | changes

    def test_schema_preserves_composite_keys_postgresql_types_and_null_defaults(self):
        schema = SchemaResponse(version=1, resources={"order_student": self.resource()})
        resource = schema.model_dump(mode="json")["resources"]["order_student"]
        self.assertEqual(resource["key"], ["order_id", "student_id"])
        self.assertEqual(resource["fields"]["reason"]["type"], "character varying(500)")
        self.assertIsNone(resource["fields"]["reason"]["default"])
        self.assertEqual(resource["fields"]["order_id"]["relation"]["on_delete"], "RESTRICT")
        self.assertEqual(resource["operation_roles"], {"read": ["dean_staff"]})

    def test_schema_rejects_unknown_operations_roles_and_extra_metadata(self):
        for changes in [
            {"operations": ["approve"]}, {"operation_roles": {"approve": ["admin"]}},
            {"read_roles": ["superadmin"]}, {"password_hash": "private"},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                ResourceSpec.model_validate(self.resource(**changes))
        with self.assertRaises(ValidationError):
            ResourceField.model_validate({"type": "integer", "nullable": False, "default": None,
                                          "relation": {"table": "student", "column": "student_id", "on_delete": "RESTRICT", "secret": "private"}})

    def test_schema_requires_actual_boolean_nullability_and_numeric_version(self):
        for nullable in ["false", 0, None]:
            with self.subTest(nullable=nullable), self.assertRaises(ValidationError):
                ResourceField(type="integer", nullable=nullable, default=None)
        for version in ["1", True]:
            with self.subTest(version=version), self.assertRaises(ValidationError):
                SchemaResponse(version=version, resources={})

    def identity(self, **changes):
        values = {
            "user_id": 7,
            "login": "dean.staff",
            "roles": ["dean_staff"],
            "person_id": 12,
            "institute_ids": [1],
            "student_id": None,
            "teacher_id": None,
        }
        return values | changes

    def test_identity_has_all_nullable_fields_and_no_extra_secrets(self):
        public = Me.model_validate(self.identity()).model_dump(mode="json")
        self.assertIsNone(public["student_id"])
        self.assertIsNone(public["teacher_id"])
        with self.assertRaises(ValidationError):
            Me.model_validate(self.identity(password_hash="must-not-be-public"))
        missing = self.identity()
        del missing["teacher_id"]
        with self.assertRaises(ValidationError):
            Me.model_validate(missing)

    def test_identity_rejects_unknown_roles_and_accidental_role_widening(self):
        for roles in [["superuser"], [], ["dean_staff", "admin"]]:
            with self.subTest(roles=roles), self.assertRaises(ValidationError):
                Me.model_validate(self.identity(roles=roles))

    def test_identity_rejects_boolean_and_unsafe_javascript_ids(self):
        for value in [True, 2**53, "7"]:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                Me.model_validate(self.identity(user_id=value))

    def test_page_preserves_decimal_precision_and_temporal_values(self):
        page = ResourcePage(
            items=[{
                "employment_rate": Decimal("0.2500"),
                "amount": Decimal("999999999999999999.123456789"),
                "lesson_date": date(2026, 10, 11),
                "start_time": time(9, 30),
                "created_at": datetime(2026, 10, 11, 6, 30, tzinfo=timezone.utc),
                "dismissal_date": None,
            }],
            limit=500,
            offset=0,
            has_more=False,
        )
        row = page.model_dump(mode="json")["items"][0]
        self.assertEqual(row["employment_rate"], "0.2500")
        self.assertEqual(row["amount"], "999999999999999999.123456789")
        self.assertEqual(row["lesson_date"], "2026-10-11")
        self.assertEqual(row["start_time"], "09:30:00")
        self.assertEqual(row["created_at"], "2026-10-11T06:30:00Z")
        self.assertIsNone(row["dismissal_date"])

    def test_page_rejects_invalid_transport_bounds(self):
        for values in [{"limit": 0}, {"limit": 501}, {"offset": -1}]:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                ResourcePage.model_validate(
                    {"items": [], "limit": 500, "offset": 0, "has_more": False} | values
                )

    def test_partial_file_is_not_a_new_incompatible_job_status(self):
        job = Job(
            id="job-1", kind="attachment", status="succeeded", attempts=1,
            max_attempts=1, progress=100, result={"extraction_state": "partial"},
            error_code=None,
        )
        self.assertEqual(job.status, "succeeded")
        with self.assertRaises(ValidationError):
            Job.model_validate(job.model_dump() | {"status": "partial"})

    def test_job_progress_accepts_fractional_percent_and_rejects_invalid_json_numbers(self):
        values = {
            "id": "job-1", "kind": "attachment", "status": "running",
            "attempts": 1, "max_attempts": 1, "progress": 12.5,
            "result": None, "error_code": None,
        }
        self.assertEqual(Job.model_validate(values).progress, 12.5)
        for progress in [-1, 101, float("nan"), float("inf")]:
            with self.subTest(progress=progress), self.assertRaises(ValidationError):
                Job.model_validate(values | {"progress": progress})

    def test_error_envelope_keeps_the_client_shape(self):
        error = ErrorResponse.model_validate({
            "error": {"code": "domain_conflict", "message": "Действие недопустимо", "details": None},
            "request_id": "request-1",
        })
        self.assertEqual(error.model_dump(mode="json")["error"]["details"], None)

    def test_stored_events_reject_unknown_types_and_invalid_sequences(self):
        for values in [{"sequence": 0}, {"sequence": True}, {"event": "approve"}]:
            with self.subTest(values=values), self.assertRaises(ValidationError):
                StoredRunEvent.model_validate({
                    "sequence": 1, "event": "session",
                    "data": {"session_id": "session-1", "run_id": "run-1"},
                } | values)

    def test_stop_response_distinguishes_request_from_finished_run(self):
        active = StopResponse(run_id="run-1", stop_requested=True)
        finished = StopResponse(run_id="run-1", stop_requested=False)
        self.assertTrue(active.model_dump()["stop_requested"])
        self.assertFalse(finished.model_dump()["stop_requested"])

    def test_chat_title_cannot_overwrite_messages_or_owner(self):
        self.assertEqual(ChatTitle(title="  Мой чат  ").title, "Мой чат")
        for extra in [{"user_id": 1}, {"messages": []}, {"roles": ["admin"]}]:
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                ChatTitle.model_validate({"title": "Мой чат"} | extra)

    def test_chat_title_rejects_empty_and_oversized_names(self):
        for title in ["", "   ", "я" * 256]:
            with self.subTest(title=title), self.assertRaises(ValidationError):
                ChatTitle(title=title)

    def test_session_info_keeps_null_active_run_and_requires_timezone(self):
        values = {
            "id": "session-1", "sessionId": "session-1", "title": "Чат",
            "createdAt": datetime(2026, 10, 11, tzinfo=timezone.utc),
            "updatedAt": datetime(2026, 10, 11, tzinfo=timezone.utc),
            "activeRunId": None,
        }
        self.assertIsNone(SessionInfo.model_validate(values).model_dump()["activeRunId"])
        with self.assertRaises(ValidationError):
            SessionInfo.model_validate(values | {"createdAt": datetime(2026, 10, 11)})

    def correction(self, **changes):
        return {
            "sheet_number": "В-1", "record_book": "З-1", "new_points": 90,
            "new_is_absent": False, "reason": "Ошибка переноса результата",
        } | changes

    def test_grade_correction_does_not_accept_author_or_approval_from_model(self):
        for extra in [{"requested_by_id": 1}, {"approve": True}, {"status": "applied"}]:
            with self.subTest(extra=extra), self.assertRaises(ValidationError):
                GradeCorrectionRequest.model_validate(self.correction(**extra))

    def test_grade_correction_obeys_absence_and_database_field_bounds(self):
        GradeCorrectionRequest.model_validate(self.correction(new_points=None, new_is_absent=True))
        GradeCorrectionRequest.model_validate(self.correction(new_points=None, new_is_absent=False))
        for change in [
            {"new_is_absent": True}, {"new_points": 0}, {"new_points": 32768},
            {"new_is_absent": "false"}, {"reason": " "}, {"reason": "я" * 2001},
            {"sheet_number": "я" * 21},
        ]:
            with self.subTest(change=change), self.assertRaises(ValidationError):
                GradeCorrectionRequest.model_validate(self.correction(**change))

    def test_submit_cannot_override_the_saved_proposal_command(self):
        for data in [
            {"expected_version": 0}, {"expected_version": True},
            {"expected_version": 1, "new_points": 100},
        ]:
            with self.subTest(data=data), self.assertRaises(ValidationError):
                ProposalSubmitRequest.model_validate(data)


if __name__ == "__main__":
    unittest.main()
