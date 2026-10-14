"""Private server configuration for the separately started local agent worker."""

from contextlib import contextmanager
import json
from pathlib import Path
from typing import Literal

import psycopg
from psycopg.rows import dict_row
from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class AgentSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="AGENT_", env_file=".local/agent.env", extra="forbid")
    database_file: Path = Path(".local/p08-agent-connection.json")
    base_url: str = "http://127.0.0.1:1234/v1"
    model: str = "qwen2.5-7b-instruct"
    api_key: SecretStr = Field(default=SecretStr("local"), validation_alias=AliasChoices("OPENAI_API_KEY", "AGENT_API_KEY"))
    provider_timeout: int = Field(default=120, ge=1, le=300)
    run_timeout: int = Field(default=300, ge=1, le=900)
    max_tokens: int = Field(default=1536, ge=128, le=8192)
    temperature: float = Field(default=0, ge=0, le=2)
    reasoning_effort: Literal["none"] | None = None
    context_window: int = Field(default=16384, ge=2048, le=131072)
    prompt_tokens: int = Field(default=4261, ge=1)
    prompt_fingerprint: str = "902a16950bcff470229bf14789b64134140dc47c22f8ce5ac14f6593579138d0"

    @contextmanager
    def connect(self, read_only=False):
        parameters = json.loads(self.database_file.read_text(encoding="utf-8"))
        with psycopg.connect(**parameters, row_factory=dict_row, connect_timeout=5) as db:
            if read_only:
                db.execute("SET TRANSACTION READ ONLY")
            db.execute("SET LOCAL ROLE backend_executor")
            db.execute("SET LOCAL search_path=pg_catalog")
            db.execute("SET LOCAL statement_timeout='5s'" if read_only else "SET LOCAL statement_timeout='30s'")
            db.execute("SET LOCAL lock_timeout='5s'")
            db.execute("SET LOCAL TIME ZONE 'Europe/Moscow'")
            yield db
