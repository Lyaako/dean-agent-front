"""User-approved reason length and guarded atomic proposal reversal."""
from pathlib import Path
from alembic import op

revision = "0048_proposal_undo"
down_revision = "0047_batches"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "040_proposal_undo.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Do not discard applied reversal history or truncate correction reasons")
