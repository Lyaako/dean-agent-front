"""Expose only authenticated account snapshots and session storage to the API role."""

from pathlib import Path

from alembic import op


revision = "0004_auth_access"
down_revision = "0003_storage_checks"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "005_auth_access.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление слоя авторизации требует отдельного решения")
