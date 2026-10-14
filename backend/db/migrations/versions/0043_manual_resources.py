"""Expose scoped academic resources and align manual operations with native rights."""
from pathlib import Path
from alembic import op

revision = "0043_manual_resources"
down_revision = "0042_user_privileges"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "035_manual_resources.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve scoped academic resources; use a forward repair")
