"""Conservatively restrict organization contacts pending the access decision."""

from pathlib import Path

from alembic import op


revision = "0008_contact_guard"
down_revision = "0007_scoped_reads"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "007_scoped_reads.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Расширение доступа к контактам требует отдельного решения")
