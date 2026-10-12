"""Private worker liveness and bounded, data-free operational diagnostics."""

import argparse
import asyncio
from datetime import datetime, timezone
from functools import lru_cache
import json
import math
import os
from pathlib import Path
import re
from time import time
from uuid import UUID, uuid4
from urllib.parse import urlsplit

import httpx
import psycopg


SERVICES = frozenset({"api", "agent", "file", "knowledge", "order"})
REQUIRED_FUNCTIONS = (
    "backend_api.visible_rows(text,text)",
    "backend_api.mutate_record(text,text,jsonb,jsonb,text)",
    "backend_api.olap_facts(text,integer,integer,integer,integer)",
    "backend_api.list_chats(text,integer,integer)",
)


def log_event(service, event, **fields):
    if service not in SERVICES or not re.fullmatch(r"[a-z_]{1,64}", event):
        raise ValueError("invalid_log_event")
    record = {"time": datetime.now(timezone.utc).isoformat(), "service": service, "event": event}
    for name, value in fields.items():
        if value is None:
            continue
        if name in {"request_id", "run_id", "job_id", "proposal_id"}:
            try:
                record[name] = str(UUID(str(value)))
            except ValueError:
                continue
        elif name in {"status", "error_code", "method"}:
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_]{1,64}", value):
                record[name] = value
        elif name in {"duration_ms", "http_status", "attempts"}:
            if type(value) is int and value >= 0:
                record[name] = value
        elif name == "route" and isinstance(value, str) and re.fullmatch(r"[/A-Za-z0-9_{}-]{1,200}", value):
            record[name] = value
    print(json.dumps(record, ensure_ascii=True, separators=(",", ":")), flush=True)


def _marker(service):
    if service not in SERVICES - {"api"}:
        raise ValueError("invalid_worker")
    return Path(os.environ.get("DEANERY_HEALTH_ROOT", "/run/health")) / service / "status.json"


def mark_alive(service):
    path = _marker(service)
    # Host-only runs have no mounted health directory; never create deployment mounts implicitly.
    if not path.parent.is_dir():
        return
    temporary = path.with_name(str(uuid4()) + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump({"service": service, "checked_at": time()}, stream)
        temporary.replace(path)
    except OSError:
        log_event(service, "health_error", error_code="health_storage_unavailable")
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            log_event(service, "health_error", error_code="health_storage_unavailable")


def mark_unavailable(service):
    try:
        _marker(service).unlink(missing_ok=True)
    except OSError:
        log_event(service, "health_error", error_code="health_storage_unavailable")


def worker_status(service):
    try:
        with _marker(service).open("rb") as stream:
            payload = stream.read(1025)
        if len(payload) > 1024:
            return "unavailable"
        record = json.loads(payload)
        checked = record["checked_at"]
        if (record["service"] == service and type(checked) in (int, float)
                and math.isfinite(checked) and 0 <= time() - checked <= 45):
            return "ready"
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return "unavailable"


def database_status():
    try:
        with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=1,
                options="-c statement_timeout=1000 -c lock_timeout=1000") as db:
            db.execute("SET LOCAL ROLE backend_api")
            ready = db.execute(
                "SELECT bool_and(COALESCE(has_function_privilege(current_user,to_regprocedure(name),'EXECUTE'),false)) "
                "FROM unnest(%s::text[]) AS required(name)", (list(REQUIRED_FUNCTIONS),)).fetchone()[0]
        return "ready" if ready else "schema_unavailable"
    except (psycopg.Error, KeyError, ValueError):
        return "database_unavailable"


@lru_cache(maxsize=8)
def calibration_fingerprint(model_name, base_url, context_window, temperature=0, reasoning_effort=None):
    from langchain_core.messages import SystemMessage
    from langchain_openai import ChatOpenAI
    from backend.agent_attachments import static_fingerprint
    from backend.agent_runtime import SYSTEM_PROMPT
    from backend.agent_tools import build_tools

    # Serialize the pinned model/tools without invoking the graph, database or provider.
    model = ChatOpenAI(model=model_name, base_url=base_url, api_key="offline-calibration", temperature=temperature,
                       reasoning_effort=reasoning_effort,
                       use_responses_api=False, max_retries=0)
    bound = model.bind_tools(build_tools(None, uuid4(), uuid4(), None, None))
    payload = model._get_request_payload([SystemMessage(content=SYSTEM_PROMPT)], **bound.kwargs)
    return static_fingerprint(payload, context_window, base_url)


async def dependency_status(settings, knowledge):
    async with httpx.AsyncClient(timeout=1.5, trust_env=False, follow_redirects=False) as client:
        async def metadata(url, headers=None):
            async with client.stream("GET", url, headers={"Accept-Encoding": "identity", **(headers or {})}) as response:
                response.raise_for_status()
                body = bytearray()
                async for part in response.aiter_raw(chunk_size=8192):
                    body.extend(part)
                    if len(body) > 65536:
                        raise ValueError("metadata_too_large")
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError("invalid_metadata")
            return value

        async def model_status():
            base = urlsplit(settings.base_url)
            result = await metadata(f"{base.scheme}://{base.netloc}/api/v0/models",
                                    {"Authorization": "Bearer " + settings.api_key.get_secret_value()})
            models = result.get("data")
            if not isinstance(models, list):
                return "unavailable"
            loaded = next((item for item in models if isinstance(item, dict) and item.get("id") == settings.model
                           and item.get("state") == "loaded"), None)
            if loaded is None:
                return "unavailable"
            return "ready" if loaded.get("loaded_context_length") == settings.context_window else "uncalibrated"

        async def embedding_status():
            from backend.vector_search import MODEL, DIMENSIONS
            result = await metadata(knowledge.bge_url.rstrip("/") + "/health")
            return "ready" if (result.get("ready") is True and result.get("model") == MODEL
                and result.get("revision") == knowledge.embedding_revision
                and result.get("dense_dimensions") == DIMENSIONS and result.get("sparse") is True) else "incompatible"

        async def index_status():
            from backend.vector_search import DIMENSIONS
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", knowledge.qdrant_collection):
                return "incompatible"
            try:
                result = await metadata(knowledge.qdrant_url.rstrip("/") + "/collections/" + knowledge.qdrant_collection)
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404:
                    return "missing"
                raise
            try:
                params = result["result"]["config"]["params"]
                if (params["vectors"]["dense"]["size"] != DIMENSIONS
                    or params["vectors"]["dense"]["distance"] != "Cosine"
                    or "sparse" not in params["sparse_vectors"]):
                    return "incompatible"
                return "empty" if result["result"].get("points_count") == 0 else "ready"
            except (KeyError, TypeError):
                return "incompatible"

        async def bounded(operation):
            try:
                return await asyncio.wait_for(operation(), timeout=1.5)
            except (TimeoutError, httpx.HTTPError, ValueError, OSError):
                return "unavailable"

        model, embedding, index = await asyncio.gather(*(bounded(operation)
            for operation in (model_status, embedding_status, index_status)))
    fingerprint = await asyncio.to_thread(calibration_fingerprint, settings.model, settings.base_url, settings.context_window, settings.temperature, settings.reasoning_effort)
    calibrated = (fingerprint == settings.prompt_fingerprint
                  and settings.prompt_tokens + settings.max_tokens < settings.context_window)
    return {"model": model, "calibration": "ready" if calibrated else "uncalibrated",
            "embedding": embedding, "index": index,
            **{name + "_worker": worker_status(name) for name in ("agent", "file", "knowledge", "order")}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check-marker",))
    parser.add_argument("service", choices=sorted(SERVICES - {"api"}))
    args = parser.parse_args()
    raise SystemExit(0 if worker_status(args.service) == "ready" else 1)


if __name__ == "__main__":
    main()
