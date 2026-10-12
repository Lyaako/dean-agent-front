"""Server-owned, scoped executor for the existing React record forms."""

from pathlib import Path

from alembic import op


revision = "0010_manual_mutations"
down_revision = "0009_shared_practice_contacts"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "008_manual_mutations.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Откат функций записи требует отдельного решения")
