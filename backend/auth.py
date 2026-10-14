"""Database-backed opaque sessions for the pinned React auth contract."""

from datetime import datetime, timezone
from hashlib import sha256
import hmac
import secrets

from argon2 import PasswordHasher, exceptions as argon_errors
import bcrypt
from fastapi import HTTPException
from psycopg import Connection

from backend.contracts import Me


hasher = PasswordHasher()


def digest(raw: str) -> bytes:
    return sha256(raw.encode("utf-8")).digest()


def token() -> str:
    return secrets.token_urlsafe(32)


def verify_password(password: str, stored: str) -> bool:
    try:
        if stored.startswith("$argon2"):
            return hasher.verify(stored, password)
        if stored.startswith(("$2a$", "$2b$", "$2y$")):
            return bcrypt.checkpw(password.encode("utf-8"), stored.encode("ascii"))
    except (ValueError, UnicodeError, argon_errors.VerificationError):
        pass
    return False


def snapshot(db: Connection, user_id: int) -> tuple[Me, bool] | None:
    row = db.execute("SELECT * FROM backend_api.account_snapshot(%s)", (user_id,)).fetchone()
    if row is None:
        return None
    me = Me(
        user_id=row["user_id"], login=row["login"], roles=[row["role_code"]],
        person_id=row["person_id"], institute_ids=row["institute_ids"],
        student_id=row["student_id"], teacher_id=row["teacher_id"],
        must_change_password=db.execute("SELECT backend_api.password_required(%s) AS required", (user_id,)).fetchone()["required"],
    )
    return me, row["is_active"]


def login(db: Connection, login_name: str, password: str) -> tuple[str, str, str]:
    account = db.execute("SELECT * FROM backend_api.login_account(%s)", (login_name,)).fetchone()
    if not account or not account["is_active"] or not verify_password(password, account["password_hash"]):
        raise HTTPException(status_code=401, detail="invalid_credentials")
    csrf, access, refresh = token(), token(), token()
    session_id = db.execute(
        """INSERT INTO agent_backend.auth_session(user_id,csrf_hash,expires_at)
           VALUES (%s,%s,now() + interval '7 days') RETURNING id""",
        (account["user_id"], digest(csrf)),
    ).fetchone()["id"]
    db.execute(
        """INSERT INTO agent_backend.auth_token(token_hash,session_id,kind,generation,expires_at)
           VALUES (%s,%s,'access',0,now() + interval '15 minutes'),
                  (%s,%s,'refresh',0,now() + interval '7 days')""",
        (digest(access), session_id, digest(refresh), session_id),
    )
    db.execute("SELECT backend_api.mark_login(%s)", (account["user_id"],))
    return access, refresh, csrf


def access_actor(db: Connection, raw: str) -> tuple[Me, str]:
    row = db.execute(
        """SELECT s.id AS session_id,s.user_id,s.expires_at AS session_expires,
                  s.revoked_at,t.expires_at AS token_expires,t.revoked_at AS token_revoked
           FROM agent_backend.auth_token t JOIN agent_backend.auth_session s ON s.id=t.session_id
           WHERE t.token_hash=%s AND t.kind='access'""", (digest(raw),),
    ).fetchone()
    now = datetime.now(timezone.utc)
    if not row or row["revoked_at"] or row["token_revoked"] or row["session_expires"] <= now or row["token_expires"] <= now:
        raise HTTPException(status_code=401, detail="invalid_token")
    actor = snapshot(db, row["user_id"])
    if actor is None or not actor[1]:
        raise HTTPException(status_code=401, detail="inactive_session")
    return actor[0], str(row["session_id"])


def refresh_session(db: Connection, raw: str, csrf: str) -> tuple[str, str]:
    row = db.execute(
        """SELECT t.session_id,t.generation,t.expires_at AS token_expires,t.used_at,t.revoked_at AS token_revoked,
                  s.user_id,s.csrf_hash,s.expires_at AS session_expires,s.revoked_at AS session_revoked
           FROM agent_backend.auth_token t JOIN agent_backend.auth_session s ON s.id=t.session_id
           WHERE t.token_hash=%s AND t.kind='refresh' FOR UPDATE OF t,s""", (digest(raw),),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=401, detail="invalid_token")
    now = datetime.now(timezone.utc)
    if not hmac.compare_digest(digest(csrf), row["csrf_hash"]):
        raise HTTPException(status_code=403, detail="forbidden")
    if row["used_at"] is not None:
        db.execute("UPDATE agent_backend.auth_session SET revoked_at=now() WHERE id=%s AND revoked_at IS NULL", (row["session_id"],))
        db.execute("UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id=%s AND revoked_at IS NULL", (row["session_id"],))
        return "", ""
    if row["session_revoked"] or row["token_revoked"] or row["token_expires"] <= now or row["session_expires"] <= now:
        raise HTTPException(status_code=401, detail="inactive_session")
    actor = snapshot(db, row["user_id"])
    if actor is None or not actor[1]:
        raise HTTPException(status_code=401, detail="inactive_session")
    if actor[0].must_change_password:
        raise HTTPException(status_code=403, detail="password_change_required")
    access, new_refresh = token(), token()
    db.execute("UPDATE agent_backend.auth_token SET used_at=now() WHERE token_hash=%s", (digest(raw),))
    db.execute(
        """INSERT INTO agent_backend.auth_token(token_hash,session_id,kind,generation,expires_at)
           VALUES (%s,%s,'access',%s,LEAST(now()+interval '15 minutes',%s)),
                  (%s,%s,'refresh',%s,%s)""",
        (digest(access),row["session_id"],row["generation"]+1,row["session_expires"],
         digest(new_refresh),row["session_id"],row["generation"]+1,row["session_expires"]),
    )
    return access, new_refresh


def logout(db: Connection, session_id: str) -> None:
    db.execute("UPDATE agent_backend.auth_session SET revoked_at=now() WHERE id=%s AND revoked_at IS NULL", (session_id,))
    db.execute("UPDATE agent_backend.auth_token SET revoked_at=now() WHERE session_id=%s AND revoked_at IS NULL", (session_id,))
