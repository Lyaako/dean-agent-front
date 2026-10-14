"""Manual corrections join the existing approval queue."""
from pathlib import Path
from alembic import op

revision = "0046_manual_corrections"
down_revision = "0045_analytics"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "038_manual_corrections.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep correction and decision history; use a forward migration")
