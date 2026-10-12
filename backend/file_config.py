"""Private storage and the separately launched local OCR worker."""
from contextlib import contextmanager
import json
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class FileSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FILES_", extra="forbid")
    storage_root: Path = Path(".local/files")
    database_file: Path = Path(".local/p10-files-connection.json")
    page_timeout: int = Field(default=160, ge=1, le=300)
    inspect_timeout: int = Field(default=30, ge=1, le=90)

    @contextmanager
    def connect(self):
        parameters = json.loads(self.database_file.read_text(encoding="utf-8"))
        with psycopg.connect(**parameters, row_factory=dict_row, connect_timeout=5) as db:
            db.execute("SET LOCAL search_path=pg_catalog")
            db.execute("SET LOCAL statement_timeout='5s'")
            db.execute("SET LOCAL lock_timeout='5s'")
            yield db
