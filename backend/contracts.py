"""Public response contracts expected by the pinned React client."""

from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator,
)


Role = Literal["admin", "director", "dean_staff", "teacher", "student"]
Operation = Literal["read", "create", "update", "delete", "workflow"]
ProposalStatus = Literal["pending", "approved", "rejected"]
JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
SseEventName = Literal["status", "session", "tool_call", "tool_result", "done", "error"]
SafeId = Annotated[int, Field(strict=True, ge=-(2**53 - 1), le=2**53 - 1)]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Me(ApiModel):
    user_id: SafeId
    login: str
    roles: Annotated[list[Role], Field(min_length=1, max_length=1)]
    person_id: SafeId | None
    institute_ids: list[SafeId]
    student_id: SafeId | None
    teacher_id: SafeId | None


class LoginResponse(ApiModel):
    access_token: str
    csrf_token: str


class RefreshResponse(ApiModel):
    access_token: str


class FieldRelation(ApiModel):
    table: str
    column: str
    on_delete: str


class ResourceField(ApiModel):
    type: str
    nullable: Annotated[bool, Field(strict=True)]
    default: str | None
    description: str | None = None
    relation: FieldRelation | None = None


class ResourceSpec(ApiModel):
    kind: Literal["table", "view"]
    key: list[str]
    fields: dict[str, ResourceField]
    read_fields: list[str]
    write_fields: list[str]
    read_roles: list[Role]
    write_roles: list[Role]
    operations: list[Operation]
    operation_roles: dict[Operation, list[Role]]
    workflow_only: list[str]


class SchemaResponse(ApiModel):
    version: Annotated[int, Field(strict=True)]
    resources: dict[str, ResourceSpec]


class ErrorBody(ApiModel):
    code: str
    message: str
    details: Any | None


class ErrorResponse(ApiModel):
    error: ErrorBody
    request_id: str


class ResourcePage(ApiModel):
    items: list[dict[str, Any]]
    limit: Annotated[int, Field(strict=True, ge=1, le=500)]
    offset: Annotated[int, Field(strict=True, ge=0)]
    has_more: bool


class Job(ApiModel):
    id: str
    kind: str
    status: JobStatus
    attempts: Annotated[int, Field(strict=True, ge=0)]
    max_attempts: Annotated[int, Field(strict=True, ge=1)]
    progress: Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
    result: dict[str, Any] | None
    error_code: str | None


class StoredRunEvent(ApiModel):
    sequence: Annotated[int, Field(strict=True, ge=1)]
    event: SseEventName
    data: dict[str, Any]


class StopResponse(ApiModel):
    run_id: str
    stop_requested: bool


class ChatTitle(ApiModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]


class ChatSummary(ChatTitle):
    id: str
    updatedAt: AwareDatetime
    preview: Annotated[str, Field(max_length=120)]


class SessionInfo(ChatTitle):
    id: str
    sessionId: str
    createdAt: AwareDatetime
    updatedAt: AwareDatetime
    activeRunId: str | None


class AttachmentRef(ApiModel):
    file_id: UUID
    version_id: UUID


class ChatRequest(ApiModel):
    message: Annotated[str, Field(min_length=1, max_length=16000)]
    session_id: UUID | None = None
    attachments: Annotated[list[AttachmentRef], Field(max_length=5)] = Field(default_factory=list)

    @model_validator(mode="after")
    def nonempty_message(self):
        if not self.message.strip():
            raise ValueError("Сообщение не может быть пустым")
        return self


class EmptyRequest(ApiModel):
    pass


class ProposalSubmitRequest(ApiModel):
    expected_version: Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)]


class ProposalDecisionRequest(ApiModel):
    approve: Annotated[bool, Field(strict=True)]
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=2000)]
    expected_version: Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)] | None = None


class ProposalAssignmentRequest(ApiModel):
    assignee_user_id: Annotated[int, Field(strict=True, gt=0, le=2**31 - 1)]
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
    expected_version: Annotated[int, Field(strict=True, ge=1, le=2**31 - 1)]


class GradeCorrectionRequest(ApiModel):
    sheet_number: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)]
    record_book: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)]
    new_points: Annotated[int, Field(strict=True, gt=0, le=32767)] | None
    new_is_absent: Annotated[bool, Field(strict=True)]
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]

    @model_validator(mode="after")
    def validate_absence(self):
        if self.new_points is not None and self.new_is_absent:
            raise ValueError("Баллы и неявка не могут быть указаны одновременно")
        return self
