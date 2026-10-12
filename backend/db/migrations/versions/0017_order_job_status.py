"""Read delayed-order job state through the current actor's scope."""

from pathlib import Path
from alembic import op

revision = "0017_order_job_status"
down_revision = "0016_order_worker"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "012_order_job_status.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    op.execute("DROP FUNCTION backend_api.order_job_status(UUID,TEXT)")
