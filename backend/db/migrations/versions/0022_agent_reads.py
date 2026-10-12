"""Share scoped read rules with trusted agent runs without minting access tokens."""

from pathlib import Path
from alembic import op

revision = "0022_agent_reads"
down_revision = "0021_chat_runs"
branch_labels = None
depends_on = None


def upgrade():
    folder = Path(__file__).resolve().parents[1] / "sql"
    for name in ("007_scoped_reads.sql", "009_olap_facts.sql", "017_agent_reads.sql"):
        op.get_bind().exec_driver_sql((folder / name).read_text(encoding="utf-8"),
                                     execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Остановите worker; откат прав агента требует отдельной миграции")
