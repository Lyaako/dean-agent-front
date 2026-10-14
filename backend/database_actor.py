"""Use the authenticated user's database privileges for domain operations."""
from contextlib import contextmanager
from fastapi import HTTPException
from psycopg import sql
from psycopg.pq import TransactionStatus


@contextmanager
def user_context(db, user_id, *, agent_read=False, prepare=False, read_only=False, password_change=False):
    context = db.execute("SELECT backend_api.database_actor(%s) AS actor", (user_id,)).fetchone()["actor"]
    if not context:
        raise HTTPException(403, "forbidden")
    if context.get("must_change_password", False) and not password_change:
        raise HTTPException(403, "password_change_required")
    role = ('deanery_read' if read_only else 'deanery_agent') if context['role']=='student' else context['db_login']
    if agent_read or prepare:
        role='deanery_agent'
    if not role:
        raise HTTPException(503, "personal_roles_unprovisioned")
    previous = db.execute("SELECT current_setting('role') AS role,current_setting('app.user_id',TRUE) AS user_id").fetchone()
    db.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
    db.execute("SELECT set_config('app.user_id',%s,TRUE)", (str(user_id),))
    try:
        yield
    finally:
        if db.info.transaction_status != TransactionStatus.INERROR:
            if not (read_only or agent_read or prepare):
                db.execute('SET CONSTRAINTS ALL IMMEDIATE')
            if previous["role"] in ("none", ""):
                db.execute("SET LOCAL ROLE NONE")
            else:
                db.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(previous["role"])))
            db.execute("SELECT set_config('app.user_id',%s,TRUE)", (previous["user_id"] or "",))
