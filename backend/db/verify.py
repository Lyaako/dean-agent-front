"""Check an isolated, migrated P01 database containing the supplied test seed."""

import json
import os
from pathlib import Path
import re
import sys
import unittest

import psycopg
from psycopg.conninfo import make_conninfo


if len(sys.argv) != 2:
    raise SystemExit("Usage: python -m backend.db.verify <private-connection.json>; use only the isolated test database")

root = Path(__file__).resolve().parents[2]
info = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
os.environ["TEST_DATABASE_DSN"] = make_conninfo(**info)
suite = unittest.defaultTestLoader.discover(str(root / "backend/tests"), pattern="test_*.py")
result = unittest.TextTestRunner(verbosity=1).run(suite)
if not result.wasSuccessful():
    raise SystemExit(1)

script = (root / "references/database/06_tests.sql").read_text(encoding="utf-8")
if re.search(r"(?m)^\\(?!echo )", script):
    raise SystemExit("Unsupported psql directive; execute the original script with psql instead")
script = re.sub(r"(?m)^\\echo .*?$", "", script)
notices = []
with psycopg.connect(**info, autocommit=True) as connection:
    connection.add_notice_handler(lambda notice: notices.append(notice.message_primary))
    cursor = connection.execute(script, prepare=False)
    while cursor.nextset():
        pass

log = root / ".local" / "p01-sql-tests.log"
log.parent.mkdir(exist_ok=True)
log.write_text("\n".join(notices), encoding="utf-8")
passed = sum(message.startswith("✓") for message in notices)
print(f"Original SQL checks passed: {passed}. Test rows rolled back; notices saved locally.")
