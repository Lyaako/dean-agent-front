"""Close linked-person and cross-institute mutation gaps."""

from pathlib import Path

from alembic import op


revision = "0011_manual_relation_guards"
down_revision = "0010_manual_mutations"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "008_manual_mutations.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8").replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Откат серверных проверок связей требует отдельного решения")
