"""Teacher reads the plan row and group of own sheets; server-side sheet roster."""
from pathlib import Path
from alembic import op

revision = "0058_teacher_sheets"
down_revision = "0057_decision_contract"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "050_teacher_sheets.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep teacher sheet reads")
