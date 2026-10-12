"""Server-owned conversations and short-lived API database transactions."""

from contextlib import contextmanager
import os
from uuid import UUID

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


@contextmanager
def connection():
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as db:
        db.execute("SET LOCAL ROLE backend_api")
        db.execute("SET LOCAL search_path TO pg_catalog,deanery")
        db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
        yield db


def listing(db, token: str, limit: int, offset: int):
    return db.execute("SELECT backend_api.list_chats(%s,%s,%s) AS result", (token, limit, offset)).fetchone()["result"]


def create(db, title: str, key: UUID, token: str):
    return db.execute("SELECT backend_api.create_chat(%s,%s,%s) AS result", (title, key, token)).fetchone()["result"]


def get(db, chat_id: UUID, token: str):
    return db.execute("SELECT backend_api.get_chat(%s,%s) AS result", (chat_id, token)).fetchone()["result"]


def messages(db, chat_id: UUID, token: str, limit: int, offset: int):
    return db.execute("SELECT backend_api.chat_messages(%s,%s,%s,%s) AS result", (chat_id, token, limit, offset)).fetchone()["result"]


def rename(db, chat_id: UUID, title: str, token: str):
    return db.execute("SELECT backend_api.rename_chat(%s,%s,%s) AS result", (chat_id, title, token)).fetchone()["result"]


def delete(db, chat_id: UUID, token: str):
    db.execute("SELECT backend_api.delete_chat(%s,%s)", (chat_id, token))


def start(db, payload, key: UUID, token: str):
    return db.execute("SELECT backend_api.start_agent_run(%s,%s,%s,%s,%s) AS result",
        (payload.session_id, payload.message, Jsonb([item.model_dump(mode="json") for item in payload.attachments]), key, token)).fetchone()["result"]


def events(db, run_id: UUID, token: str, after: int):
    return db.execute("SELECT backend_api.read_agent_events(%s,%s,%s) AS result", (run_id, token, after)).fetchone()["result"]


def cancel(db, run_id: UUID, token: str):
    return db.execute("SELECT backend_api.cancel_agent_run(%s,%s) AS result", (run_id, token)).fetchone()["result"]


def attachment_context(db, run_id: UUID, token: str):
    return db.execute("SELECT backend_api.run_attachment_context(%s,%s) AS result", (run_id, token)).fetchone()["result"]
