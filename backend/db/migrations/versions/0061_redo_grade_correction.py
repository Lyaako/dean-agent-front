"""Redo for a rejected grade correction, including one filed through the form."""
from pathlib import Path
from alembic import op

revision = "0061_redo_grade_correction"
down_revision = "0060_olap_metrics"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "053_redo_grade_correction.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the grade correction redo rule")
