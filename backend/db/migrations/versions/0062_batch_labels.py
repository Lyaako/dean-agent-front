"""Readable labels for batch proposal rows."""
from pathlib import Path
from alembic import op

revision = "0062_batch_labels"
down_revision = "0061_redo_grade_correction"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "054_batch_labels.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the batch row labels")
