"""OLAP: the five screen modes are computed in SQL; the API gets the ready answer, not the fact set."""
from pathlib import Path
from alembic import op

revision = "0065_olap_sql"
down_revision = "0064_olap_teacher_groups"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "057_olap_sql.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the OLAP SQL functions")
