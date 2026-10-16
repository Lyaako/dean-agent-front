"""HTTP entry point for the pinned React client."""

from collections import defaultdict, deque
from datetime import date, timedelta
import os
from threading import Lock
from time import monotonic
from uuid import UUID, uuid4
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
import psycopg
from psycopg.types.json import Jsonb

from backend import auth
from backend import resources
from backend import olap
from backend import proposals
from backend.database_errors import domain_error
from backend.database_actor import user_context
from backend import chats, streaming, files
from backend.service_status import database_status, dependency_status, log_event
from backend.knowledge_config import KnowledgeSettings
from backend.file_parser import AttachmentError
from backend.agent_config import AgentSettings
from backend.presentation import ApiJSONResponse
from backend.contracts import (ChatRequest, ChatTitle, EmptyRequest, Job, Me,
                               ManualGradeCorrectionRequest, ProposalAssignmentRequest, ProposalDecisionRequest, ProposalSubmitRequest,
                               ProposalUndoRequest)


app = FastAPI(title="Деканат: агент и данные",default_response_class=ApiJSONResponse)
COOKIE = "deanery_refresh"
_attempts: dict[tuple[str, str], deque[float]] = defaultdict(deque)
_attempt_lock = Lock()


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=1024)


class PasswordChangeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=8, max_length=1024)


def error(request: Request, status: int, code: str, message: str | None = None, details: Any = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message or code, "details": details},
                 "request_id": request.state.request_id},
    )


@app.middleware("http")
async def request_boundary(request: Request, call_next):
    request.state.request_id = str(uuid4())
    started = monotonic()
    origin = os.environ.get("DEANERY_ORIGIN")
    if request.method not in ("GET", "HEAD", "OPTIONS") and (not origin or request.headers.get("origin") != origin):
        response = error(request, 403, "invalid_origin", "Недопустимый источник запроса")
    else:
        try:
            response = await call_next(request)
        except Exception:
            response = error(request, 500, "internal_error", "Внутренняя ошибка сервера")
    response.headers["X-Request-ID"] = request.state.request_id
    committed = (request.path_params | getattr(request.state, "operation_ids", {})) if response.status_code < 400 else {}
    log_event("api", "http_response", request_id=request.state.request_id, method=request.method,
              route=getattr(request.scope.get("route"), "path", None), http_status=response.status_code,
              duration_ms=int((monotonic() - started) * 1000),
              **{name: committed.get(name) for name in ("run_id", "job_id", "proposal_id")})
    return response


@app.get("/api/v1/health/ready")
def readiness():
    state = database_status()
    return JSONResponse({"status": "ready" if state == "ready" else "unavailable",
                         **({} if state == "ready" else {"error_code": state})},
                        status_code=200 if state == "ready" else 503)


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict):
        return error(request, exc.status_code, exc.detail["code"], exc.detail.get("message"), exc.detail.get("details"))
    code = str(exc.detail)
    return error(request, exc.status_code, code)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    return error(request, 422, "validation_error", "Некорректные поля запроса")


@app.exception_handler(psycopg.Error)
async def database_error(request: Request, exc: psycopg.Error):
    domain = domain_error(exc)
    if domain is not None:
        return error(request, *domain)
    proposal_errors = {
        "P6001": (409, "idempotency_conflict"), "P6002": (409, "proposal_expired"),
        "P6003": (409, "stale_proposal"), "P6004": (409, "proposal_decided"),
        "P6005": (409, "concurrent_change"), "P6006": (404, "proposal_not_found"),
        "P8001": (404, "session_not_found"), "P8002": (409, "session_busy"),
        "P8003": (412, "agent_attachments_unsupported"), "P8007": (409, "agent_cancelled"),
        "P8008": (403, "agent_scope_changed"), "P8009": (409, "agent_outcome_unknown"),
        "P8101": (409, "file_not_ready"), "P8102": (413, "body_too_large"),
        "P8103": (409, "file_lease_lost"),
    }
    if exc.sqlstate in proposal_errors:
        status, code = proposal_errors[exc.sqlstate]
        return error(request, status, code)
    if exc.sqlstate == "42501":
        return error(request, 403, "forbidden", "Недостаточно прав")
    if exc.sqlstate == "P0002":
        return error(request, 404, "not_found", "Запись не найдена")
    if exc.sqlstate in ("23505", "23503", "23P01", "P0001", "40001", "40P01"):
        return error(request, 409, "conflict", "Действие конфликтует с текущими данными")
    if exc.sqlstate in ("23502", "23514", "22023", "22P02", "22007", "22008", "22003", "22001"):
        return error(request, 422, "invalid_record", "Некорректные данные записи")
    return error(request, 503, "database_unavailable", "База данных временно недоступна")


def db_connection():
    with chats.connection() as db:
        yield db


def bearer(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer ") or not authorization[7:]:
        raise HTTPException(status_code=401, detail="invalid_token")
    return authorization[7:]


def actor(request: Request, authorization: str | None = Header(default=None), db=Depends(db_connection, scope="function")) -> tuple[Me, str]:
    authorized = auth.access_actor(db, bearer(authorization))
    if authorized[0].must_change_password and request.url.path not in (
            "/api/v1/auth/me", "/api/v1/auth/password", "/api/v1/auth/logout"):
        raise HTTPException(status_code=403, detail="password_change_required")
    return authorized


def _set_cookie(response: Response, value: str) -> None:
    response.set_cookie(
        COOKIE, value, max_age=7 * 24 * 60 * 60, httponly=True,
        secure=os.environ.get("DEANERY_DEV_INSECURE_COOKIE") != "1",
        samesite="lax", path="/api/v1/auth",
    )


def _limited(host: str, login_name: str) -> bool:
    now = monotonic()
    with _attempt_lock:
        failures = _attempts[(host, login_name.casefold())]
        while failures and failures[0] <= now - 300:
            failures.popleft()
        return len(failures) >= 5


def _failed(host: str, login_name: str) -> None:
    with _attempt_lock:
        _attempts[(host, login_name.casefold())].append(monotonic())


def _succeeded(host: str, login_name: str) -> None:
    with _attempt_lock:
        _attempts.pop((host, login_name.casefold()), None)


@app.post("/api/v1/auth/login")
def login(payload: LoginRequest, request: Request, response: Response, db=Depends(db_connection, scope="function")):
    host = request.client.host if request.client else "unknown"
    if _limited(host, payload.login):
        raise HTTPException(status_code=429, detail="login_rate_limit")
    try:
        access, refresh, csrf = auth.login(db, payload.login, payload.password)
    except HTTPException:
        _failed(host, payload.login)
        raise
    _succeeded(host, payload.login)
    _set_cookie(response, refresh)
    return {"access_token": access, "csrf_token": csrf}


@app.post("/api/v1/auth/refresh")
def refresh(request: Request, response: Response, csrf: str | None = Header(default=None, alias="X-CSRF-Token"), db=Depends(db_connection, scope="function")):
    raw = request.cookies.get(COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="invalid_token")
    if not csrf:
        raise HTTPException(status_code=403, detail="forbidden")
    access, next_refresh = auth.refresh_session(db, raw, csrf)
    if not access:
        response.status_code = 401
        response.delete_cookie(COOKIE, path="/api/v1/auth")
        return {"error": {"code": "inactive_session", "message": "Сессия завершена", "details": None},
                "request_id": request.state.request_id}
    _set_cookie(response, next_refresh)
    return {"access_token": access}


@app.get("/api/v1/auth/me", response_model=Me)
def me(authorized=Depends(actor)):
    return authorized[0]


@app.post("/api/v1/auth/logout", status_code=204)
def logout(response: Response, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    auth.logout(db, authorized[1])
    response.delete_cookie(COOKIE, path="/api/v1/auth")


@app.get("/api/v1/schema")
def get_schema(authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db,authorized[0].user_id,read_only=True):
        return resources.schema(db, authorized[0])


@app.post("/api/v1/auth/password", status_code=204)
def change_password(payload: PasswordChangeRequest, request: Request,
                    authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    token = request.headers["authorization"][7:]
    stored = db.execute("SELECT backend_api.own_password_hash(%s) AS hash", (token,)).fetchone()["hash"]
    if not auth.verify_password(payload.current_password, stored):
        raise HTTPException(status_code=403, detail="invalid_current_password")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=422, detail="password_unchanged")
    with user_context(db,authorized[0].user_id,password_change=True):
        db.execute("SELECT backend_api.change_password(%s,%s)", (token, auth.hasher.hash(payload.new_password)))


@app.post("/api/v1/auth/logout-all", status_code=204)
def logout_all(request: Request, response: Response, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    db.execute("SELECT backend_api.logout_all(%s)", (request.headers["authorization"][7:],))
    response.delete_cookie(COOKIE, path="/api/v1/auth", secure=os.environ.get("DEANERY_DEV_INSECURE_COOKIE") != "1", httponly=True, samesite="strict")


@app.get("/api/v1/me/profile")
def own_profile(request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return db.execute("SELECT backend_api.own_profile(%s) AS profile", (request.headers["authorization"][7:],)).fetchone()["profile"]


@app.post("/api/v1/admin/users/{user_id}/reset-password")
def reset_password(user_id: int, request: Request, idempotency_key: UUID = Header(),
                   authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    if authorized[0].roles[0] != "admin":
        raise HTTPException(status_code=403, detail="forbidden")
    password = auth.token()
    with user_context(db,authorized[0].user_id):
        issued = db.execute("SELECT backend_api.reset_password(%s,%s,%s,%s) AS issued",
            (request.headers["authorization"][7:],user_id,idempotency_key,auth.hasher.hash(password))).fetchone()["issued"]
    if not issued:
        raise HTTPException(status_code=409, detail="password_already_issued")
    return {"user_id": user_id, "temporary_password": password, "must_change_password": True}


@app.get("/api/v1/resources/{name}")
def get_resource(name: str, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db,authorized[0].user_id,read_only=True):
        return resources.list_rows(db, name, authorized[0].roles[0],
                                   request.headers["authorization"][7:], dict(request.query_params))


@app.get("/api/v1/resources/grade_sheet/{sheet_id}/missing")
def sheet_missing(sheet_id: int, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db,authorized[0].user_id,read_only=True):
        return {"items": db.execute("SELECT backend_api.sheet_missing(%s,%s) AS items",
            (sheet_id,request.headers["authorization"][7:])).fetchone()["items"]}


@app.get("/api/v1/resources/grade_sheet/{sheet_id}/roster")
def sheet_roster(sheet_id: int, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    # Состав ведомости по правилам базы. Права проверяет сама функция по токену, поэтому вызов без личной роли:
    # недоступная ведомость (в том числе для студента) — 404, как несуществующая.
    return {"items": db.execute("SELECT backend_api.sheet_roster(%s,%s) AS items",
        (sheet_id,request.headers["authorization"][7:])).fetchone()["items"]}


def _record_action(name: str, action: str, request: Request, key: dict[str, str],
                   data: dict[str, Any], authorized: tuple[Me, str], db):
    info = resources.spec(db, name, authorized[0].roles[0])
    if authorized[0].roles[0] not in info.operation_roles.get(action, []):
        raise HTTPException(status_code=403, detail="forbidden")
    with user_context(db, authorized[0].user_id):
        row = db.execute(
            "SELECT backend_api.mutate_record(%s,%s,%s,%s,%s) AS record",
            (name, action, Jsonb(key), Jsonb(data), request.headers["authorization"][7:]),
        ).fetchone()
    return row["record"]


@app.post("/api/v1/resources/{name}")
def create_resource(name: str, data: dict[str, Any], request: Request,
                    authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return _record_action(name, "create", request, {}, data, authorized, db)


@app.patch("/api/v1/resources/{name}")
def update_resource(name: str, data: dict[str, Any], request: Request,
                    authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return _record_action(name, "update", request, dict(request.query_params), data, authorized, db)


@app.delete("/api/v1/resources/{name}")
def delete_resource(name: str, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return _record_action(name, "delete", request, dict(request.query_params), {}, authorized, db)


@app.get("/api/v1/olap")
def get_olap(request: Request, mode: str = "rollup-group", group_id: int | None = None,
             discipline_id: int | None = None, semester: int | None = None,
             status_id: int | None = None, course: int | None = None, level: str | None = None,
             mod_min: int = 30, att_min: float = 70, period: str = 'month', pick: str | None = None,
             authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db,authorized[0].user_id,read_only=True):
        return _olap_report(request,mode,group_id,discipline_id,semester,status_id,course,level,mod_min,att_min,period,pick,db)


def _olap_report(request,mode,group_id,discipline_id,semester,status_id,course,level,mod_min,att_min,period,pick,db):
    if mode in olap.ANALYSES:
        return olap.analyze(db,request.headers['authorization'][7:],mode,group_id=group_id,
            discipline_id=discipline_id,semester=semester,status_id=status_id,course=course,level=level,
            mod_min=mod_min,att_min=att_min,period=period,pick=pick)
    return olap.report(db, request.headers["authorization"][7:], mode,
                       group_id, discipline_id, semester, status_id)


@app.get("/api/v1/audit")
def audit_events(request: Request, changed_at__gte: str | None = None, changed_at__lte: str | None = None,
                 table_name: Annotated[str | None, Query(max_length=63)] = None,
                 operation: Literal["I", "U", "D"] | None = None,
                 changed_by: Annotated[str | None, Query(max_length=63)] = None,
                 source: Literal["ui", "agent"] | None = None,
                 limit: Annotated[int, Query(ge=1, le=500)] = 100,
                 offset: Annotated[int, Query(ge=0, le=2**31 - 1)] = 0,
                 authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    bounds = []
    for raw, end in ((changed_at__gte, False), (changed_at__lte, True)):
        try:
            value = resources._value(raw, "timestamp with time zone")
        except ValueError:
            raise HTTPException(status_code=422, detail="invalid_value") from None
        if value is not None and end and len(raw) == 10:
            value += timedelta(days=1) - timedelta(microseconds=1)
        bounds.append(value)
    return db.execute("SELECT backend_api.audit_events(%s,%s,%s,%s,%s,%s,%s,%s,%s) AS result",
        (request.headers["authorization"][7:], *bounds, table_name, operation, changed_by, source,
         limit, offset)).fetchone()["result"]


@app.post("/api/v1/workflows/{name}")
def run_workflow(name: str, data: dict[str, Any], request: Request,
                 idempotency_key: UUID = Header(), authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db, authorized[0].user_id):
        return db.execute("SELECT backend_api.run_workflow(%s,%s,%s,%s) AS result",
                          (name, Jsonb(data), idempotency_key, request.headers["authorization"][7:])).fetchone()["result"]


@app.get("/api/v1/jobs/{job_id}", response_model=Job)
def get_job(job_id: UUID, request: Request, page_offset: Annotated[int, Query(ge=0)] = 0,
            page_limit: Annotated[int, Query(ge=1, le=100)] = 100,
            authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return files.get_job(db, job_id, request.headers["authorization"][7:], page_offset, page_limit)


@app.get("/api/v1/orders/signers")
def order_signers(request: Request, institute_id: Annotated[int, Query(gt=0)],
                  authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return {"items": db.execute("SELECT backend_api.order_signers(%s,%s) AS items",
        (institute_id,request.headers["authorization"][7:])).fetchone()["items"]}


# Номер приказа содержит «/» (например «151-с/26»), а Starlette раскодирует %2F до сопоставления маршрута,
# поэтому номер — :path; хвост /students/{id}/cancel отделяет его однозначно.
@app.post("/api/v1/orders/{order_number:path}/students/{student_id}/cancel")
def cancel_order(order_number: str, student_id: int, request: Request, idempotency_key: UUID = Header(),
                 authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    if authorized[0].roles[0] not in resources.STAFF:
        raise HTTPException(403, "forbidden")
    with user_context(db,authorized[0].user_id):
        return db.execute("SELECT backend_api.cancel_order(%s,%s,%s,%s) AS result",
            (order_number,student_id,idempotency_key,request.headers["authorization"][7:])).fetchone()["result"]


@app.exception_handler(AttachmentError)
async def attachment_error(request: Request, exc: AttachmentError):
    return error(request, 503, str(exc), "Материалы файла временно недоступны")


@app.post("/api/v1/files", status_code=201)
async def upload_file(request: Request, idempotency_key: UUID = Header(), authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    result = await files.upload(request, db, request.headers["authorization"][7:], idempotency_key)
    request.state.operation_ids = {"job_id": result["job"]["id"]}
    return result


@app.get("/api/v1/files/{file_id}/versions/{version_id}/download")
def download_file(file_id: UUID, version_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    import hashlib
    descriptor = files.download_descriptor(db, file_id, version_id, request.headers["authorization"][7:])
    path = files.storage_path(descriptor['storage_key'])
    try:
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != descriptor['content_hash'] or path.stat().st_size != descriptor['byte_size']:
            raise AttachmentError('original_integrity_error')
    except OSError:
        raise AttachmentError('storage_unavailable') from None
    return FileResponse(path, media_type=descriptor['mime'], filename=descriptor['filename'],
                        headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})


@app.get("/api/v1/agent/runs/{run_id}/attachment-context")
def attachment_context(run_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.attachment_context(db, run_id, request.headers["authorization"][7:])


@app.get("/api/v1/agent/proposals")
def list_proposals(request: Request, box: Literal["incoming", "mine", "completed"] = "incoming",
                   status: Literal["pending", "approved", "rejected"] | None = None,
                   execution_status: Literal["not_started", "scheduled", "running", "succeeded", "failed", "cancelled"] | None = None,
                   limit: Annotated[int, Query(ge=1, le=100)] = 50,
                   offset: Annotated[int, Query(ge=0, le=2**31 - 1)] = 0,
                   author: Annotated[str | None, Query(max_length=200)] = None,
                   created_from: date | None = None, created_to: date | None = None,
                   authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return proposals.listing(db, request.headers["authorization"][7:], box, status, execution_status,
                             limit, offset, author, created_from, created_to)


@app.post('/api/v1/grade-corrections')
def create_correction(payload: ManualGradeCorrectionRequest, request: Request, idempotency_key: UUID = Header(),
                      authorized=Depends(actor), db=Depends(db_connection, scope='function')):
    if authorized[0].roles[0] not in resources.NO_STUDENT:
        raise HTTPException(403,'forbidden')
    with user_context(db,authorized[0].user_id):
        return db.execute('SELECT backend_api.create_correction(%s,%s,%s,%s,%s,%s,%s) AS result',
            (payload.sheet_id,payload.student_id,payload.new_points,payload.new_is_absent,payload.reason,
             idempotency_key,request.headers['authorization'][7:])).fetchone()['result']


@app.get("/api/v1/agent/proposals/{proposal_id}")
def get_proposal(proposal_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return proposals.get(db, proposal_id, request.headers["authorization"][7:])


def _invalid(field: str, message: str) -> HTTPException:
    return HTTPException(422, {"code": "validation_error", "message": message, "details": {"field": field}})


@app.post('/api/v1/agent/proposals/{proposal_id}/undo')
def undo_proposal(proposal_id: UUID, request: Request, payload: ProposalUndoRequest | None = None,
                  idempotency_key: UUID = Header(), authorized=Depends(actor), db=Depends(db_connection, scope='function')):
    picked = payload.picked_item_ids if payload else None
    if picked is not None and (not picked or len(set(picked)) != len(picked)):
        raise _invalid("picked_item_ids", "Выберите применённые строки без повторов")
    with user_context(db,authorized[0].user_id):
        return db.execute('SELECT backend_api.undo_proposal(%s,%s,%s,%s) AS result',
            (proposal_id,idempotency_key,request.headers['authorization'][7:],
             Jsonb(picked) if picked is not None else None)).fetchone()['result']


@app.get("/api/v1/agent/proposals/{proposal_id}/assignees")
def proposal_assignees(proposal_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return proposals.assignees(db, proposal_id, request.headers["authorization"][7:])


@app.get("/api/v1/agent/proposals/{proposal_id}/events")
def proposal_events(proposal_id: UUID, request: Request, after: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
                    limit: Annotated[int, Query(ge=1, le=100)] = 50,
                    authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return proposals.events(db, proposal_id, request.headers["authorization"][7:], after, limit)


@app.post("/api/v1/agent/proposals/{proposal_id}/assignment")
def assign_proposal(proposal_id: UUID, payload: ProposalAssignmentRequest, request: Request,
                    idempotency_key: UUID = Header(), authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    if not 10 <= len(payload.reason) <= 2000:
        raise _invalid("reason", "Причина передачи — от 10 до 2000 символов")
    return proposals.assign(db, proposal_id, payload, idempotency_key, request.headers["authorization"][7:])


@app.post("/api/v1/agent/proposals/{proposal_id}/submit")
def submit_proposal(proposal_id: UUID, payload: ProposalSubmitRequest, request: Request,
                    idempotency_key: UUID = Header(alias="Idempotency-Key"), authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db, authorized[0].user_id):
        return proposals.submit(db, proposal_id, payload, idempotency_key, request.headers["authorization"][7:])


@app.post("/api/v1/agent/proposals/{proposal_id}/decision")
def decide_proposal(proposal_id: UUID, payload: ProposalDecisionRequest, request: Request,
                    idempotency_key: UUID = Header(), authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    with user_context(db, authorized[0].user_id):
        return proposals.decide(db, proposal_id, payload, idempotency_key, request.headers["authorization"][7:])


@app.get("/api/v1/agent/sessions")
def list_chats(request: Request, limit: Annotated[int, Query(ge=1, le=500)] = 50,
               offset: Annotated[int, Query(ge=0, le=2**31 - 1)] = 0, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.listing(db, request.headers["authorization"][7:], limit, offset)


@app.post("/api/v1/agent/sessions", status_code=201)
def create_chat(payload: ChatTitle, request: Request, idempotency_key: UUID = Header(),
                authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.create(db, payload.title, idempotency_key, request.headers["authorization"][7:])


@app.get("/api/v1/agent/sessions/{chat_id}")
def get_chat(chat_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.get(db, chat_id, request.headers["authorization"][7:])


@app.get("/api/v1/agent/sessions/{chat_id}/messages")
def get_chat_messages(chat_id: UUID, request: Request, limit: Annotated[int, Query(ge=1, le=500)] = 50,
                       offset: Annotated[int, Query(ge=0, le=2**31 - 1)] = 0, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.messages(db, chat_id, request.headers["authorization"][7:], limit, offset)


@app.patch("/api/v1/agent/sessions/{chat_id}")
def rename_chat(chat_id: UUID, payload: ChatTitle, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    return chats.rename(db, chat_id, payload.title, request.headers["authorization"][7:])


@app.delete("/api/v1/agent/sessions/{chat_id}", status_code=204)
def delete_chat(chat_id: UUID, request: Request, authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    chats.delete(db, chat_id, request.headers["authorization"][7:])


def event_response(run_id: UUID, token: str, after: int):
    return StreamingResponse(streaming.events(run_id, token, after), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/v1/agent/chat/stream")
def start_chat_stream(payload: ChatRequest, request: Request, idempotency_key: UUID = Header(), authorization: str | None = Header(default=None)):
    token = bearer(authorization)
    # End the transaction before opening SSE so the independent worker can see the queued run.
    with chats.connection() as db:
        me=auth.access_actor(db, token)[0]
        if me.must_change_password:
            raise HTTPException(403,'password_change_required')
        with user_context(db,me.user_id):
            started = chats.start(db, payload, idempotency_key, token)
    request.state.operation_ids = {"run_id": started["run_id"]}
    return event_response(UUID(started["run_id"]), token, 0)


@app.get("/api/v1/agent/runs/{run_id}/events")
def replay_chat_stream(run_id: UUID, after: Annotated[int, Query(ge=0, le=2**63 - 1)] = 0,
                       authorization: str | None = Header(default=None)):
    token = bearer(authorization)
    with chats.connection() as db:
        if auth.access_actor(db, token)[0].must_change_password:
            raise HTTPException(403,'password_change_required')
        chats.events(db, run_id, token, after)
    return event_response(run_id, token, after)


@app.post("/api/v1/agent/runs/{run_id}/cancel")
def cancel_chat_run(run_id: UUID, payload: EmptyRequest, request: Request, response: Response,
                    authorized=Depends(actor), db=Depends(db_connection, scope="function")):
    result = chats.cancel(db, run_id, request.headers["authorization"][7:])
    response.status_code = 202 if result["stop_requested"] else 200
    return result


@app.get("/api/v1/agent/capabilities")
async def agent_capabilities(authorized=Depends(actor)):
    try:
        services = await dependency_status(AgentSettings(), KnowledgeSettings())
    except (ValueError, OSError):
        services = {"model": "unavailable", "calibration": "uncalibrated"}
    ready = all(services.get(name) == "ready" for name in ("model", "calibration", "agent_worker"))
    result = {"attachment_context": {"protocol": "deanery.attachments.v1", "backend_supported": True,
        "agent_supported": True, "agent_status": "ready" if ready else "unavailable",
        "max_attachments": 5, "max_total_bytes": 20000000, "max_text_chunks": 20}}
    if authorized[0].roles[0] == "admin":
        result["services"] = services
    return result
