"""Portable, single-request calibration; no database or application tools are executed."""
import argparse
import json
from pathlib import Path
import re
import secrets
from unittest.mock import patch
from uuid import uuid4

import httpx
from langchain_openai import ChatOpenAI
from langsmith import tracing_context

from backend.agent_attachments import static_fingerprint, verify_provider_context
from backend.agent_config import AgentSettings
from backend.agent_runtime import create_agent_graph
from backend.agent_tools import TOOL_NAMES, build_tools

class CaptureOnly(RuntimeError):
    pass

def serialize(model, base_url, temperature=0, reasoning_effort=None):
    """Capture the real SDK serialization before network; never fabricate a response."""
    captured = []

    def capture(_transport, request):
        assert request.method == "POST" and request.url.path.endswith("/chat/completions")
        captured.append(json.loads(request.content))
        raise CaptureOnly("offline_serialization_only")

    with httpx.Client(transport=httpx.HTTPTransport(), trust_env=False, timeout=5) as client:
        chat = ChatOpenAI(model=model, base_url=base_url, api_key="local", temperature=temperature,
                          reasoning_effort=reasoning_effort,
                          use_responses_api=False, max_retries=0, max_tokens=1, http_client=client,
                          http_socket_options=())
        graph = create_agent_graph(chat, build_tools(None, uuid4(), uuid4(), None, None))
        try:
            with patch.object(httpx.HTTPTransport, "handle_request", capture), tracing_context(enabled=False):
                graph.invoke({"messages": [{"role": "user", "content": "Калибровка."}]})
        except Exception:
            if len(captured) != 1:
                raise
    assert len(captured) == 1
    payload = captured[0]
    assert {t["function"]["name"] for t in payload["tools"]} == TOOL_NAMES
    return payload

def measure(settings):
    verify_provider_context(settings)
    payload = serialize(settings.model, settings.base_url, settings.temperature, settings.reasoning_effort)
    with httpx.Client(timeout=settings.provider_timeout, trust_env=False) as client:
        response = client.post(settings.base_url.rstrip('/') + '/chat/completions', json=payload,
                               headers={'Authorization': 'Bearer ' + settings.api_key.get_secret_value()})
        response.raise_for_status()
        usage = response.json()['usage']
    count = usage['prompt_tokens']
    if not isinstance(count, int) or count <= 0 or settings.context_window <= count + 256 + settings.max_tokens + 512:
        raise ValueError('Provider token usage does not fit the configured context')
    return {'model': settings.model, 'base_url': settings.base_url, 'context_window': settings.context_window,
            'max_tokens': settings.max_tokens, 'temperature': settings.temperature,
            'reasoning_effort': settings.reasoning_effort, 'prompt_tokens': count + 256,
            'prompt_fingerprint': static_fingerprint(payload, settings.context_window, settings.base_url),
            'native_provider_requests': 1, 'tool_count': len(TOOL_NAMES)}


def apply_result(path, result):
    path = Path(path)
    settings = AgentSettings(_env_file=path)
    for key in ('model', 'base_url', 'context_window', 'max_tokens', 'temperature', 'reasoning_effort'):
        if result.get(key) != getattr(settings, key):
            raise ValueError('Calibration does not match the current model configuration')
    if result.get('native_provider_requests') != 1 or result.get('tool_count') != len(TOOL_NAMES):
        raise ValueError('Expected one native request with exactly thirteen tools')
    tokens, fingerprint = result.get('prompt_tokens'), result.get('prompt_fingerprint')
    if type(tokens) is not int or tokens <= 256 or settings.context_window <= tokens + settings.max_tokens + 512:
        raise ValueError('Invalid calibrated token budget')
    if not isinstance(fingerprint, str) or not re.fullmatch('[0-9a-f]{64}', fingerprint):
        raise ValueError('Invalid calibration fingerprint')
    original = path.read_text(encoding='utf-8')
    updated = original
    for name, value in [('AGENT_PROMPT_TOKENS', tokens), ('AGENT_PROMPT_FINGERPRINT', fingerprint)]:
        updated, count = re.subn(r'^' + name + r'=.*$', name + '=' + str(value), updated, flags=re.MULTILINE)
        if count != 1:
            raise ValueError('Expected exactly one setting in the private environment file')
    backup = path.with_name(path.name + '.before-calibration-' + secrets.token_hex(4))
    temporary = path.with_name(path.name + '.pending-' + secrets.token_hex(4))
    with backup.open('x', encoding='utf-8') as stream:
        stream.write(original)
    backup.chmod(0o600)
    with temporary.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(updated)
    temporary.chmod(0o600)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('measure', 'apply'))
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--result', type=Path)
    args = parser.parse_args()
    if args.operation == 'measure':
        print(json.dumps(measure(AgentSettings(_env_file=args.env_file))))
    else:
        if args.result is None:
            parser.error('apply requires --result')
        apply_result(args.env_file, json.loads(args.result.read_text(encoding='utf-8-sig')))
        print('Calibration applied; previous private configuration retained.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('Calibration failed (' + type(error).__name__ + '); credentials and provider output were not printed') from None
