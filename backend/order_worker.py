"""Execute due orders; use a separate database login with backend_worker membership."""

import argparse
import os
from time import monotonic, sleep
from uuid import uuid4

import psycopg
from backend.service_status import log_event, mark_alive, mark_unavailable


def run_once(dsn: str, worker_id) -> dict | None:
    # Claim must commit before work starts so a crashed process leaves a recoverable lease.
    with psycopg.connect(dsn, connect_timeout=5, options="-c statement_timeout=30000 -c lock_timeout=5000") as db:
        db.execute("SET LOCAL ROLE backend_worker")
        job_id = db.execute("SELECT backend_api.claim_order_job(%s)",(worker_id,)).fetchone()[0]
    mark_alive("order")
    if job_id is None:
        return None
    log_event("order", "job_started", job_id=job_id)
    with psycopg.connect(dsn, connect_timeout=5, options="-c statement_timeout=30000 -c lock_timeout=5000") as db:
        db.execute("SET LOCAL ROLE backend_worker")
        return db.execute("SELECT backend_api.perform_order_job(%s,%s)",(job_id,worker_id)).fetchone()[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once",action="store_true")
    args = parser.parse_args()
    worker_id = uuid4()
    while True:
        started = monotonic()
        try:
            result = run_once(os.environ["WORKER_DATABASE_URL"],worker_id)
            if result:
                log_event("order", "job_finished", job_id=result.get("id"), status=result.get("status"),
                          error_code=result.get("error_code"), duration_ms=int((monotonic() - started) * 1000))
        except psycopg.Error as exc:
            mark_unavailable("order")
            log_event("order", "worker_error", error_code=exc.sqlstate or "database_unavailable")
            if args.once:
                raise SystemExit(1) from None
            result = None
        if args.once:
            return
        if result is None:
            sleep(5)


if __name__ == "__main__":
    main()
