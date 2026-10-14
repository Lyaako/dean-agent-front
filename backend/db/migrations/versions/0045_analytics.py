"""Read-only native facts for the five frontend analyses."""
from pathlib import Path
from alembic import op

revision = "0045_analytics"
down_revision = "0044_orders_and_reads"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "037_analytics.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Use a forward migration for analytics")
