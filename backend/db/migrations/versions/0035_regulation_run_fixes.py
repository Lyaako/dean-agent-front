"""Close current-generation, source-budget and terminal-provenance gaps."""
from pathlib import Path
from alembic import op

revision = "0035_regulation_run_fixes"
down_revision = "0034_knowledge_job_fixes"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "028_regulation_run_fixes.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Normative evidence is retained; use a forward repair")
