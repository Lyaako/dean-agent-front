"""Scoped token-based reads for student database transactions."""
from pathlib import Path
from alembic import op

revision = "0054_read_context"
down_revision = "0053_order_executor"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "046_read_context.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Use a forward change for scoped student read RPCs")
