"""Scoped supplementary reads and ordinary future-order cancellation."""
from pathlib import Path
from alembic import op

revision = "0044_orders_and_reads"
down_revision = "0043_manual_resources"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "036_orders_and_reads.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep cancellation history; use a forward migration")
