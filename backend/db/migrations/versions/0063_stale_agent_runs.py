"""Stale agent runs end on first access, not only when a worker polls."""
from pathlib import Path
from alembic import op

revision = "0063_stale_agent_runs"
down_revision = "0062_batch_labels"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "055_stale_agent_runs.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the stale agent run rule")
