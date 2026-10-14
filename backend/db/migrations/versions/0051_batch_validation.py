"""Validate pending detail rows through rolled-back native execution."""
from pathlib import Path
from alembic import op

revision = "0051_batch_validation"
down_revision = "0050_batch_snapshots"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "043_batch_validation.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Use a forward change for batch detail validation")
