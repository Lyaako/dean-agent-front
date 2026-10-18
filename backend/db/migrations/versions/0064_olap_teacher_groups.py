"""OLAP: the teacher scope of the eight earlier modes matches the five new ones (groups of assignments)."""
from pathlib import Path
from alembic import op

revision = "0064_olap_teacher_groups"
down_revision = "0063_stale_agent_runs"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "056_olap_teacher_groups.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the OLAP teacher scope")
