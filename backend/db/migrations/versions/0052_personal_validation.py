"""Rolled-back native validation for staff-only proposal operations."""
from pathlib import Path
from alembic import op

revision = "0052_personal_validation"
down_revision = "0051_batch_validation"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "044_personal_validation.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep native personal validation; use a forward migration")
