"""Owned server conversations and durable leased agent runs."""

from pathlib import Path
from alembic import op

revision = "0021_chat_runs"
down_revision = "0020_proposal_null_guards"
branch_labels = None
depends_on = None


def upgrade():
    directory = Path(__file__).resolve().parents[1] / "sql"
    for name in ("014_prepare_proposal.sql", "016_chat_runs.sql"):
        op.get_bind().exec_driver_sql((directory / name).read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("История чатов и запусков не удаляется обратной миграцией")
