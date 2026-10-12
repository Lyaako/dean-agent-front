"""Narrow persistence calls shared by HTTP and the future agent runner."""

from uuid import UUID
from datetime import date
from psycopg.types.json import Jsonb


def prepare(db, run_id: UUID, command: dict, explanation: str, reason: str,
            key: UUID, access_token: str, supersedes: UUID | None = None):
    return db.execute("SELECT backend_api.prepare_proposal(%s,%s,%s,%s,%s,%s,%s) AS result",
        (run_id, Jsonb(command), explanation, reason, key, access_token, supersedes)).fetchone()["result"]


def prepare_for_run(db, run_id: UUID, worker: UUID, command: dict, explanation: str,
                    reason: str, key: UUID, supersedes: UUID | None = None):
    return db.execute("SELECT backend_api.prepare_run_proposal(%s,%s,%s,%s,%s,%s,%s) AS result",
        (run_id, worker, Jsonb(command), explanation, reason, key, supersedes)).fetchone()["result"]


def get(db, proposal_id: UUID, access_token: str):
    return db.execute("SELECT backend_api.get_proposal(%s,%s) AS result",
        (proposal_id, access_token)).fetchone()["result"]


def listing(db, access_token: str, box: str, status: str | None, execution_status: str | None,
            limit: int, offset: int, author: str | None = None,
            created_from: date | None = None, created_to: date | None = None):
    return db.execute("SELECT backend_api.list_proposals(%s,%s,%s,%s,%s,%s,%s,%s,%s) AS result",
        (access_token, box, status, execution_status, limit, offset, author, created_from, created_to)).fetchone()["result"]


def assignees(db, proposal_id: UUID, access_token: str):
    return db.execute("SELECT backend_api.proposal_assignees(%s,%s) AS result",
        (proposal_id, access_token)).fetchone()["result"]


def assign(db, proposal_id: UUID, payload, key: UUID, access_token: str):
    return db.execute("SELECT backend_api.assign_proposal(%s,%s,%s,%s,%s,%s) AS result",
        (proposal_id, payload.assignee_user_id, payload.reason, payload.expected_version,
         key, access_token)).fetchone()["result"]


def decide(db, proposal_id: UUID, payload, key: UUID, access_token: str):
    return db.execute("SELECT backend_api.decide_proposal(%s,%s,%s,%s,%s,%s) AS result",
        (proposal_id, payload.approve, payload.reason, payload.expected_version,
         key, access_token)).fetchone()["result"]


def events(db, proposal_id: UUID, access_token: str, after: int, limit: int):
    return db.execute("SELECT backend_api.proposal_events(%s,%s,%s,%s) AS result",
        (proposal_id, access_token, after, limit)).fetchone()["result"]


def submit(db, proposal_id: UUID, payload, key: UUID, access_token: str):
    return db.execute("SELECT backend_api.submit_proposal(%s,%s,%s,%s) AS result",
        (proposal_id, payload.expected_version, key, access_token)).fetchone()["result"]
