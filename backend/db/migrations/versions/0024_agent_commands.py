"""Complete immutable root commands and scoped agent facts through the shared engine."""

from pathlib import Path
from alembic import op

revision = "0024_agent_commands"
down_revision = "0023_special_commands"
branch_labels = None
depends_on = None


def upgrade():
    folder = Path(__file__).resolve().parents[1] / "sql"
    for name in ("019_agent_commands.sql", "008_manual_mutations.sql", "007_scoped_reads.sql",
                 "017_agent_reads.sql", "013_command_engine.sql"):
        op.get_bind().exec_driver_sql((folder / name).read_text(encoding="utf-8"),
                                     execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Остановите worker и выполните согласованную forward-repair миграцию; история сохраняется")
