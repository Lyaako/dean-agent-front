"""Reject a slot assigned to a semester other than its curriculum item."""

from pathlib import Path

from alembic import op


revision = "0014_slot_term_guard"
down_revision = "0013_olap_scope_once"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "008_manual_mutations.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8").replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Откат проверки семестра расписания требует отдельного решения")
