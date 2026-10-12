"""Upgrade an isolated local database using an ignored connection JSON file."""

import json
import os
from pathlib import Path
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy.engine import URL


if len(sys.argv) != 2:
    raise SystemExit("Usage: python -m backend.db.upgrade_local .local/<connection>.json")

info = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
os.environ["DATABASE_URL"] = URL.create(
    "postgresql+psycopg", username=info["user"], password=info["password"],
    host=info["host"], port=info["port"], database=info["dbname"],
).render_as_string(hide_password=False)
command.upgrade(Config("alembic.ini"), "head")
print(f"Upgraded {info['dbname']}")
