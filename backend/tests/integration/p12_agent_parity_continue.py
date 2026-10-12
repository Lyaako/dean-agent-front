"""I135: one natural self-document request using the unchanged parity harness."""

from datetime import datetime, timezone
import json
import sys
import traceback
from unittest.mock import patch

import httpx

from backend.agent_attachments import static_fingerprint
from backend.agent_tools import TOOL_NAMES
from backend.tests.integration.p12_agent_parity import DATABASE, ROOT, Runtime, document_request, save


PURPOSE = "Синтетическая проверка P12: справка для учебного сценария"


def natural_request(document_name):
    return (f"Подготовь для меня новую заявку на документ «{document_name}» в двух экземплярах. "
            f"В назначении справки укажи дословно: «{PURPOSE}». "
            "Причина: мне нужны две справки для учебного сценария синтетической проверки "
            "согласованного процесса выдачи справки P12. Подготовь одно предложение "
            "для последующего отдельного рассмотрения сотрудником деканата.")


class NaturalDocumentRuntime(Runtime):
    def model(self, case, login, _technical_fixture_message):
        assert (case, login) == ("document_request", "ivanov.ks")
        catalog = self.call(login, "GET", "resources/document_type?sort=document_type_id&limit=1")
        document = catalog["items"][0]
        with self.admin() as db:
            expected = db.execute("SELECT document_type_id FROM deanery.document_type "
                                  "ORDER BY document_type_id LIMIT 1").fetchone()["document_type_id"]
        assert document["document_type_id"] == expected
        message = natural_request(document["name"])
        submitted = []
        original_send = httpx.Client.send

        def record_api(client, request, **kwargs):
            if request.method == "POST" and request.url.path == "/api/v1/agent/chat/stream":
                submitted.append(json.loads(request.content))
            return original_send(client, request, **kwargs)

        # Supply the natural message before the API submission; do not edit provider input.
        try:
            with patch.object(httpx.Client, "send", record_api):
                return super().model(case, login, message)
        finally:
            frames = self.prefix.with_name(self.prefix.name + "-" + case + "-provider.jsonl")
            requests = [frame["request"] for line in frames.read_text(encoding="utf-8").splitlines()
                        if "request" in (frame := json.loads(line))] if frames.exists() else []
            stored_request = stored_chat = None
            if self.runs:
                run_id = self.runs[-1][1]
                with self.admin() as db:
                    stored_request = db.execute("SELECT q.request_text FROM deanery.agent_request q "
                        "JOIN agent_backend.agent_run r USING(agent_request_id) WHERE r.id=%s", (run_id,)).fetchone()["request_text"]
                    stored_chat = db.execute("SELECT text FROM agent_backend.chat_message "
                        "WHERE role='user' AND metadata->>'run_id'=%s", (str(run_id),)).fetchone()["text"]
            verification = {
                "ordinary_catalog_document": document, "actual_api_bodies": submitted,
                "server_request_text": stored_request, "server_user_message": stored_chat,
                "native_provider_requests": len(requests),
                "provider_user_message_matches": all(any(item["role"] == "user" and item["content"] == message
                    for item in payload["messages"]) for payload in requests),
                "exact_13_tools": all({item["function"]["name"] for item in payload["tools"]} == TOOL_NAMES
                                      for payload in requests),
                "static_fingerprints": [static_fingerprint(payload, self.settings.context_window, self.settings.base_url)
                                        for payload in requests],
            }
            save(self.prefix.with_name(self.prefix.name + "-natural-input.json"), verification)
            assert len(submitted) == 1 and submitted[0]["message"] == message
            assert stored_request == stored_chat == message
            assert 0 < len(requests) <= 8 and verification["provider_user_message_matches"]
            assert verification["exact_13_tools"]
            assert all(value == self.settings.prompt_fingerprint for value in verification["static_fingerprints"])


def run():
    runtime = NaturalDocumentRuntime()
    result, error = None, None
    try:
        runtime.start()
        result = document_request(runtime)
        save(runtime.prefix.with_name(runtime.prefix.name + "-document_request-parity.json"), result)
    except BaseException as exc:
        error = type(exc).__name__
        runtime.prefix.with_name(runtime.prefix.name + "-error.log").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        cleanup = runtime.close()
    summary = {"time": datetime.now(timezone.utc).isoformat(), "decision": "I135", "database": DATABASE,
               "phase": "natural_document_request", "cases": [result] if result else [], "error_type": error,
               "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}
    save(runtime.prefix.with_name(runtime.prefix.name + "-summary.json"), summary)
    print(json.dumps({"phase": summary["phase"], "passed_cases": int(result is not None), "error_type": error,
                      "cleanup": cleanup, "evidence_prefix": runtime.prefix.name}), flush=True)
    return 0 if result and error is None and not cleanup["errors"] and cleanup["owned_api_stopped"] and \
        cleanup["active_auth_sessions"] == cleanup["active_auth_tokens"] == cleanup["queued_or_running_runs"] == 0 else 1


if __name__ == "__main__":
    assert ROOT == ROOT.cwd().resolve()
    assert len(sys.argv) == 2 and sys.argv[1] in ("natural_document_request", "self_check")
    if sys.argv[1] == "self_check":
        message = natural_request("Справка об обучении")
        assert PURPOSE in message and "двух экземплярах" in message
        assert not any(value in message for value in ("student_id", "null", "prepare_record_change", "fields="))
        print("Natural input self-check passed; provider requests=0")
    else:
        sys.exit(run())
