"""Apply system jobs through the database's public due-order operation."""
from pathlib import Path
from alembic import op

revision = "0053_order_executor"
down_revision = "0052_personal_validation"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "045_order_executor.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve native public execution and system audit identity")
