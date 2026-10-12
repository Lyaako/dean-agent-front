"""Run durable queued agent requests outside the HTTP event loop."""

import argparse
from time import monotonic, sleep
from uuid import uuid4

import psycopg

from backend.agent_config import AgentSettings
from backend.agent_runtime import execute_run
from backend.service_status import log_event, mark_alive, mark_unavailable


def run_once(settings, worker_id):
    with settings.connect() as db:
        claimed = db.execute("SELECT backend_api.claim_agent_run(%s) AS result", (worker_id,)).fetchone()["result"]
    mark_alive("agent")
    if claimed is None:
        return None
    started = monotonic()
    log_event("agent", "run_started", run_id=claimed["run_id"])
    result = execute_run(settings, claimed["run_id"], worker_id)
    log_event("agent", "run_finished", run_id=claimed["run_id"], status=result.get("status"),
              error_code=result.get("error_code"), duration_ms=int((monotonic() - started) * 1000))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings, worker_id = AgentSettings(), uuid4()
    while True:
        try:
            result = run_once(settings, worker_id)
        except Exception:
            mark_unavailable("agent")
            log_event("agent", "worker_error", error_code="agent_worker_error")
            if args.once:
                raise SystemExit(1) from None
            result = None
        if args.once:
            return
        if result is None:
            sleep(2)


if __name__ == "__main__":
    main()
