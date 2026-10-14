"""Bound batch snapshots to the edited rows and current author scope."""
from pathlib import Path
from alembic import op

revision = "0050_batch_snapshots"
down_revision = "0049_preview_metadata"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "042_batch_snapshots.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Use a forward change for snapshot format")
