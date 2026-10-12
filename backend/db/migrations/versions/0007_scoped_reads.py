"""Constrain all public resource reads by a live bearer token and real relationships."""

from pathlib import Path

from alembic import op


revision = "0007_scoped_reads"
down_revision = "0006_frontend_keys"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "007_scoped_reads.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление защищённого чтения требует отдельного решения")
