"""Treat nullable ownership and routing comparisons as denial."""

from pathlib import Path
from alembic import op

revision = "0020_proposal_null_guards"
down_revision = "0019_proposals"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "015_proposal_null_guards.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Ослабление проверки видимости предложений запрещено")
