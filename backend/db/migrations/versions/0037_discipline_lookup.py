"""Expose the existing authenticated discipline catalog to the React OLAP lookup."""
from pathlib import Path
from alembic import op

revision = "0037_discipline_lookup"
down_revision = "0036_proposal_filters"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "030_discipline_lookup.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve authenticated discipline reads; use a forward repair")
