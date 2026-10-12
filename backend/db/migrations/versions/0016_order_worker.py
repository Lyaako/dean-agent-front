"""Persist, lease and reconcile delayed order execution."""

from pathlib import Path
from alembic import op

revision = "0016_order_worker"
down_revision = "0015_workflows"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "011_order_worker.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление учёта фонового исполнения требует отдельного решения")
