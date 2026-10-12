"""Scoped final-result and debt facts for the eight OLAP modes."""

from pathlib import Path

from alembic import op


revision = "0012_olap_facts"
down_revision = "0011_manual_relation_guards"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "009_olap_facts.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Откат защищённой OLAP-проекции требует отдельного решения")
