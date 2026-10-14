"""Read captured preview metadata without widening native audit privileges."""
from pathlib import Path
from alembic import op

revision = "0049_preview_metadata"
down_revision = "0048_proposal_undo"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "041_preview_metadata.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Use a forward repair for the scoped preview metadata adapter")
