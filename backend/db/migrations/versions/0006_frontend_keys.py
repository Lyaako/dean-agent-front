"""Retain source views and expose their base row identity for the pinned UI."""

from pathlib import Path

from alembic import op


revision = "0006_frontend_keys"
down_revision = "0005_snapshot_function_path"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "006_frontend_keys.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление совместимых полей API требует отдельного решения")
