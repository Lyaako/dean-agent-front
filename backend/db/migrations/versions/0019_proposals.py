"""Immutable proposals and scoped employee queue."""

from pathlib import Path
from alembic import op

revision = "0019_proposals"
down_revision = "0018_command_engine"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "014_proposals.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})
    shared = source.with_name("014_prepare_proposal.sql")
    op.get_bind().exec_driver_sql(shared.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Предложения и их аудит не удаляются обратной миграцией; исправления вносятся следующей миграцией")
