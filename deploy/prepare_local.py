"""Create private files for a fresh local checkout; never overwrite an existing setup."""
import json
from pathlib import Path
import secrets


def prepare(root):
    root = Path(root).resolve()
    local = root / '.local'
    secret = local / 'p13-deploy-secrets'
    outputs = [local / 'p13-deploy-compose.env', secret / 'admin.json',
               secret / 'postgres-password', secret / 'agent.env']
    directories = [secret, local / 'p13-deploy-tls']
    directories += [local / 'p13-deploy-files' / name for name in ('originals', 'derived', 'temporary', 'regulations')]
    directories += [local / 'p13-deploy-health' / name for name in ('agent', 'file', 'knowledge', 'order')]
    if any(not path.resolve().is_relative_to(root) for path in [*outputs, *directories]):
        raise ValueError('Private paths must stay inside the checkout')
    if any(path.exists() for path in outputs):
        raise FileExistsError('Existing setup retained; use the resume instructions')
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    password = secrets.token_urlsafe(32)
    content = [
        (root / 'deploy/deployment.env.example').read_text(encoding='utf-8').replace('KNOWLEDGE_BGE_URL=\n', 'KNOWLEDGE_BGE_URL=http://bge:8087\n'),
        json.dumps({'host': 'db', 'port': 5432, 'dbname': 'deanery_p13', 'user': 'postgres', 'password': password}, indent=2),
        password,
        (root / 'backend/agent.env.example').read_text(encoding='utf-8')
            .replace('AGENT_DATABASE_FILE=.local/p08-agent-connection.json', 'AGENT_DATABASE_FILE=/run/secrets/agent.json')
            .replace('http://127.0.0.1:1234/v1', 'http://host.docker.internal:1234/v1')
            .replace('a676c2d9d27aa3bea5a34f3b895828bb967b8aee82bb9a6c7eaac75ba3f75e34', '0' * 64)
    ]
    for path, text in zip(outputs, content, strict=True):
        with path.open('x', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
        path.chmod(0o600)
    return outputs


if __name__ == '__main__':
    prepare(Path(__file__).resolve().parents[1])
    print('Private local files created. Passwords were not printed. See docs/GETTING_STARTED.md.')
