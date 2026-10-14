"""Selected batch decisions and guarded reversal metadata."""
from pathlib import Path
from alembic import op

revision = "0047_batches"
down_revision = "0046_manual_corrections"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "039_batches.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve immutable batch decisions and reversal history")
