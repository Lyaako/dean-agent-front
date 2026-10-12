"""Invalidate former agent history when the newly readable relationships change."""

from pathlib import Path
from alembic import op

revision = "0026_scope_reads"
down_revision = "0025_correction_proposals"
branch_labels = None
depends_on = None


def upgrade():
    folder = Path(__file__).resolve().parents[1] / "sql"
    sql = (folder / "016_chat_runs.sql").read_text(encoding="utf-8")
    signature = sql[sql.index("CREATE FUNCTION agent_backend.scope_signature("):sql.index("CREATE FUNCTION agent_backend.validate_agent_run(")]
    op.get_bind().exec_driver_sql(signature.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"),
                                 execution_options={"no_parameters": True})
    for name in ("019_agent_commands.sql", "008_manual_mutations.sql", "017_agent_reads.sql", "013_command_engine.sql"):
        op.get_bind().exec_driver_sql((folder / name).read_text(encoding="utf-8"),
                                     execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Остановите worker и исправьте область доступа отдельной миграцией; история сохраняется")
