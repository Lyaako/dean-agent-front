"""Retake roster lists only students whose failed attempt was in a sheet of the same group."""
from pathlib import Path
from alembic import op

revision = "0059_retake_roster_group"
down_revision = "0058_teacher_sheets"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "051_retake_roster_group.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the group-scoped retake roster")
