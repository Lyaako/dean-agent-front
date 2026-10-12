"""Compute the scoped student set once per OLAP query."""

from pathlib import Path

from alembic import op


revision = "0013_olap_scope_once"
down_revision = "0012_olap_facts"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "009_olap_facts.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8").replace("CREATE FUNCTION ", "CREATE OR REPLACE FUNCTION "), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Откат исправления производительности OLAP требует отдельного решения")
