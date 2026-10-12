"""I158: explicit candidate calibration/evaluation; historical defaults stay intact."""

import argparse
import base64
import ctypes
from datetime import datetime, timezone
import inspect
from hashlib import sha256
import json
from pathlib import Path
import secrets
import subprocess
import sys
import traceback
from time import monotonic
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_openai import ChatOpenAI
from langsmith import tracing_context

from backend.agent_attachments import static_fingerprint, static_payload
from backend.agent_calibration import CaptureOnly, serialize
from backend.agent_config import AgentSettings
from backend.agent_runtime import create_agent_graph
from backend.agent_tools import TOOL_NAMES, build_tools, encode
from backend.tests.integration.p12_agent_parity import LOCAL, ROOT, Runtime, academic_work, document_request, save
from backend.tests.integration.p12_agent_parity_continue import NaturalDocumentRuntime
from backend.tests.integration.p12_agent_parity_remaining import practice, schedule, fio, transfer




def host_memory():
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                    ("total_phys", ctypes.c_ulonglong), ("avail_phys", ctypes.c_ulonglong),
                    ("total_page", ctypes.c_ulonglong), ("avail_page", ctypes.c_ulonglong),
                    ("total_virtual", ctypes.c_ulonglong), ("avail_virtual", ctypes.c_ulonglong),
                    ("avail_extended_virtual", ctypes.c_ulonglong)]

    status = MemoryStatus(length=ctypes.sizeof(MemoryStatus))
    function = ctypes.WinDLL("kernel32", use_last_error=True).GlobalMemoryStatusEx
    function.argtypes = [ctypes.POINTER(MemoryStatus)]
    function.restype = ctypes.c_int
    if not function(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    assert 0 < status.avail_phys <= status.total_phys
    return {"time": datetime.now(timezone.utc).isoformat(), "total_RAM_bytes": status.total_phys,
            "available_RAM_bytes": status.avail_phys, "RAM_load_percent": status.load}




def output_details(response):
    records = []
    for choice in response.get("choices", []):
        message = choice["message"]
        content = message.get("content") or ""
        records.append({"finish_reason": choice.get("finish_reason"),
                        "reasoning_fields": [key for key in message if "reason" in key.lower()],
                        "reasoning_chars": sum(len(value) for key, value in message.items() if "reason" in key.lower() and isinstance(value, str)),
                        "visible_think_tags": isinstance(content, str) and "<think>" in content.lower(),
                        "structured_tools": [t.get("function", {}).get("name") for t in message.get("tool_calls", [])]})
    return {"usage": response.get("usage"), "choices": records}


def measure(args):
    payload = serialize(args.model, args.provider, args.temperature, getattr(args, "reasoning_effort", None))
    original = httpx.HTTPTransport.handle_request
    calls = 0
    frames = []

    def capture(transport, request):
        nonlocal calls
        if request.method == "POST" and request.url.path.endswith("/chat/completions"):
            calls += 1
            assert calls == 1
            frames.append({"request": json.loads(request.content),
                           "request_body_base64": base64.b64encode(request.content).decode("ascii")})
            response = original(transport, request)
            response.read()
            frame = {"status": response.status_code, "response_body_base64": base64.b64encode(response.content).decode("ascii")}
            frames.append(frame)
            frame["response"] = response.json()
            return response
        return original(transport, request)

    with httpx.Client(transport=httpx.HTTPTransport(), trust_env=False, timeout=120) as client:
        metadata = client.get(args.provider.removesuffix("/v1") + "/api/v0/models")
        metadata.raise_for_status()
        loaded = next(m for m in metadata.json()["data"] if m["id"] == args.model and m["state"] == "loaded")
        assert loaded["loaded_context_length"] == args.context
        error = None
        try:
            with patch.object(httpx.HTTPTransport, "handle_request", capture):
                response = client.post(args.provider.rstrip("/") + "/chat/completions", content=encode(payload).encode(),
                                       headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
        except Exception as exc:
            error = type(exc).__name__
    return {"payload": payload, "metadata": loaded, "calls": calls, "frames": frames, "error_type": error}


def docker_measurement_script():
    imports = """import base64,json,sys
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
import httpx
from langchain_openai import ChatOpenAI
from langsmith import tracing_context
from backend.agent_runtime import create_agent_graph
from backend.agent_tools import TOOL_NAMES,build_tools,encode
"""
    remote = imports + inspect.getsource(CaptureOnly) + inspect.getsource(serialize) + inspect.getsource(measure)
    return remote + "print(json.dumps(measure(SimpleNamespace(**json.load(sys.stdin))),ensure_ascii=True))\n"


def calibrate(args):
    assert args.model != "qwen2.5-7b-instruct", "Candidate calibration must not overwrite old model acceptance"
    assert 0 <= args.temperature <= 2
    assert args.reasoning_effort in (None, "none")
    memory_before = host_memory()
    started = monotonic()
    if args.docker_container:
        remote = docker_measurement_script()
        completed = subprocess.run(["docker", "exec", "-i", args.docker_container, "python", "-c", remote],
                                   input=json.dumps({"model": args.model, "provider": args.provider, "context": args.context,
                                                     "temperature": args.temperature, "reasoning_effort": args.reasoning_effort}),
                                   text=True, encoding="utf-8", capture_output=True, timeout=150,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
        completed.check_returncode()
        measured = json.loads(completed.stdout)
    else:
        measured = measure(args)
    measured["elapsed_seconds"] = monotonic() - started
    measured["host_memory_before"] = memory_before
    measured["host_memory_after"] = host_memory()
    prefix = LOCAL / ("p12-parity-candidate-" + secrets.token_hex(4))
    frames = prefix.with_name(prefix.name + "-calibration-provider.jsonl")
    with frames.open("x", encoding="utf-8") as stream:
        for frame in measured["frames"]:
            stream.write(json.dumps(frame, ensure_ascii=False) + "\n")
    save(prefix.with_name(prefix.name + "-measurement.json"), measured)
    assert measured["error_type"] is None and measured["calls"] == 1
    assert measured["frames"][-1]["status"] == 200
    payload = measured["payload"]
    body = measured["frames"][-1]["response"]
    usage = body["usage"]
    report = {"decision": "I158", "kind": "native_candidate_calibration", "model": args.model, "base_url": args.provider,
              "temperature": args.temperature,
              "reasoning_effort": args.reasoning_effort,
              "context_window": args.context, "max_tokens": args.output_tokens, "prompt_tokens": usage["prompt_tokens"] + 256,
              "prompt_fingerprint": static_fingerprint(payload, args.context, args.provider),
              "static_margin": 256, "dynamic_probe_counted_conservatively_as_static": "Калибровка.",
              "native_provider_requests": measured["calls"], "exact_13_tools": True, "loaded_metadata": measured["metadata"],
              "docker_container": args.docker_container,
              "elapsed_seconds": measured["elapsed_seconds"],
              "host_memory_before": measured["host_memory_before"], "host_memory_after": measured["host_memory_after"],
              "native_output": output_details(body), "native_frames": frames.name,
              "memory_proof": "Loaded metadata is retained; root owns measured host/VRAM peak and server load settings.",
              "capability_claim": "Calibration only; bounded natural-case outcomes are separate."}
    path = prefix.with_name(prefix.name + "-calibration.json")
    save(path, report)
    assert usage["prompt_tokens"] > 0
    assert args.context > report["prompt_tokens"] + args.output_tokens + 512
    print(json.dumps({"calibration": str(path), "model": args.model, "provider": args.provider,
                      "native_requests": measured["calls"], "usage": usage, "context": args.context,
                      "prompt_fingerprint": report["prompt_fingerprint"]}), flush=True)


class CandidateRuntime(NaturalDocumentRuntime):
    def model(self, case, login, message):
        timings = []
        original = httpx.HTTPTransport.handle_request

        def timed(transport, request):
            if request.method != "POST" or not request.url.path.endswith("/chat/completions"):
                return original(transport, request)
            started = monotonic()
            record = {"call": len(timings) + 1, "host_memory_before": host_memory()}
            try:
                response = original(transport, request)
                response.read()
                record["status"] = response.status_code
                return response
            except BaseException as exc:
                record["transport_error_type"] = type(exc).__name__
                raise
            finally:
                record["elapsed_seconds"] = monotonic() - started
                record["host_memory_after"] = host_memory()
                timings.append(record)

        try:
            with patch.object(httpx.HTTPTransport, "handle_request", timed):
                if case == "document_request":
                    return super().model(case, login, message)
                return Runtime.model(self, case, login, message)
        finally:
            save(self.prefix.with_name(self.prefix.name + "-" + case + "-provider-timings.json"), timings)


CASES = {"student_document": document_request, "academic_work": academic_work, "practice": practice, "schedule": schedule, "fio": fio, "transfer": transfer}


def repeated_shared_fault(codes):
    return sum(code in {"agent_context_limit", "agent_context_uncalibrated", "agent_protocol_error"} for code in codes) >= 2


def evaluate(args):
    calibration = json.loads(Path(args.calibration).read_text(encoding="utf-8"))
    assert calibration["kind"] == "native_candidate_calibration" and calibration["native_provider_requests"] == 1
    assert calibration["exact_13_tools"] and calibration["model"] != "qwen2.5-7b-instruct"
    selected = args.case or list(CASES)
    assert len(selected) == len(set(selected))
    settings = AgentSettings(_env_file=None, database_file=LOCAL / "p12-backend-agent.json", OPENAI_API_KEY="local",
                             temperature=calibration.get("temperature", 0),
                             reasoning_effort=calibration.get("reasoning_effort", None),
                             **{key: calibration[key] for key in ("model", "base_url", "context_window", "max_tokens", "prompt_tokens", "prompt_fingerprint")})
    runtime = CandidateRuntime(settings)
    results = []
    shared_codes = []
    shared_stop = False
    try:
        runtime.start()
        for name in selected:
            started = monotonic()
            memory_before = host_memory()
            prior_runs = len(runtime.runs)
            try:
                result = CASES[name](runtime)
                result["passed"] = True
            except BaseException as exc:
                result = {"case": name, "passed": False, "error_type": type(exc).__name__}
                runtime.prefix.with_name(runtime.prefix.name + "-candidate-" + name + "-error.log").write_text(traceback.format_exc(), encoding="utf-8")
                if len(runtime.runs) > prior_runs:
                    with runtime.admin() as db:
                        code = db.execute("SELECT error_code FROM agent_backend.agent_run WHERE id=%s", (runtime.runs[-1][1],)).fetchone()["error_code"]
                    result["native_run_error_code"] = code
                    shared_codes.append(code)
                    shared_stop = repeated_shared_fault(shared_codes)
            result["elapsed_seconds"] = monotonic() - started
            result["host_memory_before"] = memory_before
            result["host_memory_after"] = host_memory()
            results.append(result)
            save(runtime.prefix.with_name(runtime.prefix.name + "-candidate-" + name + "-outcome.json"), result)
            print(json.dumps({k:v for k,v in result.items() if k in ("case", "passed", "error_type", "provider_calls")}), flush=True)
            if shared_stop:
                break
    finally:
        cleanup = runtime.close()
    provider_responses = []
    provider_requests = 0
    for path in runtime.prefix.parent.glob(runtime.prefix.name + "-*-provider.jsonl"):
        for line in path.read_text(encoding="utf-8").splitlines():
            frame = json.loads(line)
            if "request" in frame:
                provider_requests += 1
                assert static_fingerprint(frame["request"], settings.context_window, settings.base_url) == settings.prompt_fingerprint
                assert {t["function"]["name"] for t in frame["request"]["tools"]} == TOOL_NAMES
            if "response" in frame:
                provider_responses.append({"file": path.name, **output_details(frame["response"])})
    summary = {"decision": "I158", "model": settings.model, "provider": settings.base_url, "calibration": str(args.calibration),
               "temperature": settings.temperature,
               "reasoning_effort": settings.reasoning_effort,
               "context_window": settings.context_window, "output_budget": settings.max_tokens, "prompt_budget": settings.prompt_tokens,
               "prompt_fingerprint": settings.prompt_fingerprint, "cases": results, "actual_runs": len(runtime.runs),
               "actual_provider_requests": provider_requests, "native_output_details": provider_responses, "cleanup": cleanup,
               "selected_cases": selected, "stopped_after_repeated_shared_fault": shared_stop,
               "limits": {"per_case": 8, "total": 8 * len(selected), "model_case_retries": 0}, "evidence_prefix": runtime.prefix.name}
    save(runtime.prefix.with_name(runtime.prefix.name + "-candidate-summary.json"), summary)
    assert provider_requests <= 8 * len(selected)
    print(json.dumps({"model": settings.model, "passed_cases": sum(r["passed"] for r in results), "attempted_cases": len(results),
                      "provider_requests": provider_requests, "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}), flush=True)
    return 0 if len(results) == len(selected) and all(r["passed"] for r in results) and not cleanup["errors"] and \
        cleanup["active_auth_sessions"] == cleanup["active_auth_tokens"] == cleanup["queued_or_running_runs"] == 0 else 1


def self_check():
    model, provider = "offline-candidate-serialization", "http://127.0.0.1:1234/v1"
    payload = serialize(model, provider)
    old = next(json.loads(line)["request"] for line in (LOCAL / "p12-parity-1ace6e3f-academic_work-provider.jsonl").read_text(encoding="utf-8").splitlines()
               if "request" in json.loads(line))
    expected = static_payload(old, 16384, provider)
    expected["model"] = model
    assert static_payload(payload, 16384, provider) == expected
    default = Runtime().settings
    assert default.model == "qwen2.5-7b-instruct" and default.context_window == 16384 and default.prompt_tokens == 4261 and default.temperature == 0 and default.reasoning_effort is None
    assert default.prompt_fingerprint == "902a16950bcff470229bf14789b64134140dc47c22f8ce5ac14f6593579138d0"
    assert static_fingerprint({**payload, "model": default.model}, default.context_window, default.base_url) == default.prompt_fingerprint
    assert Runtime(default).settings is default
    tuned = serialize(model, provider, temperature=0.6)
    assert tuned["temperature"] == 0.6
    assert "reasoning_effort" not in payload and "reasoning_effort" not in tuned
    assert static_fingerprint(tuned, 16384, provider) != static_fingerprint(payload, 16384, provider)
    old_calibration = json.loads((LOCAL / "p12-parity-candidate-813ba221-calibration.json").read_text(encoding="utf-8"))
    assert old_calibration.get("temperature", 0) == 0
    assert sha256(encode(static_payload(serialize(old_calibration["model"], provider), 16384, provider)).encode()).hexdigest() == old_calibration["prompt_fingerprint"]
    for path in (LOCAL / "p12-parity-candidate-5d602dc7-calibration.json", LOCAL / "p12-parity-candidate-6f8380c5-calibration.json"):
        previous = json.loads(path.read_text(encoding="utf-8"))
        historical = serialize(previous["model"], previous["base_url"], previous.get("temperature", 0))
        assert previous.get("reasoning_effort", None) is None
        assert sha256(encode(static_payload(historical, previous["context_window"], previous["base_url"])).encode()).hexdigest() == previous["prompt_fingerprint"]
    disabled = serialize(model, provider, temperature=0.6, reasoning_effort="none")
    assert disabled["reasoning_effort"] == "none"
    assert {key: value for key, value in disabled.items() if key != "reasoning_effort"} == tuned
    assert static_fingerprint(disabled, 20480, provider) != static_fingerprint(tuned, 20480, provider)
    assert len(CASES) == 6
    compile(docker_measurement_script(), "candidate_docker_calibration", "exec")
    partial = output_details({"choices": [{"message": {"reasoning_content": None, "tool_calls": [{"function": {}}]}, "finish_reason": "length"}]})
    assert partial["choices"][0]["reasoning_chars"] == 0 and partial["choices"][0]["structured_tools"] == [None]
    print("Candidate serialization/default/reuse self-check passed; provider requests=0; no runtime started")


if __name__ == "__main__":
    assert Path.cwd().resolve() == ROOT
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="operation", required=True)
    sub.add_parser("self_check")
    sub.add_parser("memory_snapshot")
    cal = sub.add_parser("calibrate")
    cal.add_argument("--model", required=True)
    cal.add_argument("--provider", required=True)
    cal.add_argument("--context", type=int, required=True)
    cal.add_argument("--output-tokens", type=int, default=1536)
    cal.add_argument("--temperature", type=float, default=0)
    cal.add_argument("--reasoning-effort", choices=("none",), default=None)
    cal.add_argument("--docker-container")
    ev = sub.add_parser("evaluate")
    ev.add_argument("--calibration", required=True)
    ev.add_argument("--case", choices=list(CASES), action="append")
    args = parser.parse_args()
    if args.operation == "memory_snapshot":
        print(json.dumps(host_memory()), flush=True)
    elif args.operation == "self_check":
        self_check()
    elif args.operation == "calibrate":
        calibrate(args)
    else:
        sys.exit(evaluate(args))
