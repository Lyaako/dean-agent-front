"""Adopt the two supplied database revisions without resetting existing data."""
from pathlib import Path

from alembic import op


revision = "0040_database_revision"
down_revision = "0039_scope_check_latency"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "032_database_revision.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve historical scholarship amounts and revised constraints; use a forward repair")
