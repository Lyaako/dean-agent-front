"""Private operator/worker storage and the explicit local BGE/Qdrant services."""
from contextlib import contextmanager
import json
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class KnowledgeSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix='KNOWLEDGE_', extra='forbid')
    storage_root: Path = Path('.local/files')
    database_file: Path = Path('.local/p11-knowledge-connection.json')
    token_file: Path = Path('.local/p11-operator-token.txt')
    inspect_timeout: int = Field(default=30, ge=1, le=90)
    page_timeout: int = Field(default=160, ge=1, le=300)
    bge_url: str = 'http://127.0.0.1:8087'
    qdrant_url: str = 'http://127.0.0.1:6337'
    qdrant_collection: str = 'deanery_regulations_v1'
    embedding_revision: str = '5617a9f61b028005a4858fdac845db406aefb181'
    vector_timeout: int = Field(default=60, ge=1, le=120)

    @contextmanager
    def connect(self):
        parameters = json.loads(self.database_file.read_text(encoding='utf-8'))
        with psycopg.connect(**parameters, row_factory=dict_row, connect_timeout=5) as db:
            db.execute('SET LOCAL search_path=pg_catalog')
            db.execute("SET LOCAL statement_timeout='5s'")
            db.execute("SET LOCAL lock_timeout='5s'")
            yield db
