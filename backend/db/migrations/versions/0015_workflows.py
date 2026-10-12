"""Adapt the six student forms to the original transactional procedures."""

from pathlib import Path
from alembic import op

revision = "0015_workflows"
down_revision = "0014_slot_term_guard"
branch_labels = None
depends_on = None


def upgrade():
    source = Path(__file__).resolve().parents[1] / "sql" / "010_workflows.sql"
    op.get_bind().exec_driver_sql(source.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление истории исполнений требует отдельного решения")
