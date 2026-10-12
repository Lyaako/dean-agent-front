"""Share the common practice contact directory with authorized staff."""

from pathlib import Path

from alembic import op


revision = "0009_shared_practice_contacts"
down_revision = "0008_contact_guard"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "007_scoped_reads.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Изменение прав на контакты требует отдельного решения")
