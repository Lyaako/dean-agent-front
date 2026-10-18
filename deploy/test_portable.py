"""Portable setup guards and real SDK serialization, without a provider or database."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.agent_calibration import apply_result, serialize
from backend.agent_attachments import static_fingerprint
from deploy.prepare_local import prepare


ROOT = Path(__file__).resolve().parents[1]


class PortableTests(unittest.TestCase):
    def test_prepare_generates_private_files_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('deploy/deployment.env.example', 'backend/agent.env.example'):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            outputs = prepare(root)
            original = [path.read_bytes() for path in outputs]
            admin = json.loads(outputs[1].read_text())
            self.assertEqual(admin['password'], outputs[2].read_text())
            self.assertGreater(len(admin['password']), 30)
            self.assertIn('KNOWLEDGE_BGE_URL=http://bge:8087', outputs[0].read_text())
            self.assertIn('AGENT_PROMPT_FINGERPRINT=' + '0' * 64, outputs[3].read_text())
            with self.assertRaises(FileExistsError):
                prepare(root)
            self.assertEqual(original, [path.read_bytes() for path in outputs])

    def test_calibration_rejects_other_profile_and_updates_only_budget(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / 'agent.env'
            original = (ROOT / 'backend/agent.env.example').read_text()
            path.write_text(original)
            report = dict(model='qwen_qwen3.5-9b', base_url='http://127.0.0.1:1234/v1', context_window=20480,
                          max_tokens=1536, temperature=0.6, reasoning_effort='none', prompt_tokens=4200,
                          prompt_fingerprint='a' * 64, native_provider_requests=1, tool_count=15)
            with self.assertRaises(ValueError):
                apply_result(path, {**report, 'base_url': 'http://other-host:1234/v1'})
            self.assertEqual(path.read_text(), original)
            apply_result(path, report)
            changed = path.read_text()
            self.assertIn('AGENT_PROMPT_TOKENS=4200', changed)
            self.assertIn('AGENT_PROMPT_FINGERPRINT=' + 'a' * 64, changed)
            self.assertIn('OPENAI_API_KEY=local', changed)
            self.assertEqual(len(list(path.parent.glob('agent.env.before-calibration-*'))), 1)

    def test_shared_serializer_preserves_accepted_fifteen_tool_fingerprint(self):
        # 15-th tool get_olap_analysis (0065_olap_sql); the model budget must be re-measured by agent_calibration.
        payload = serialize('qwen_qwen3.5-9b', 'http://127.0.0.1:1234/v1', 0.6, 'none')
        self.assertEqual(len(payload['tools']), 15)
        self.assertEqual(static_fingerprint(payload, 20480, 'http://127.0.0.1:1234/v1'),
                         '778eb08ade52d37037512109faac4fab53891a32ad891da2e5d53bef3f1c1330')


if __name__ == '__main__':
    unittest.main()
