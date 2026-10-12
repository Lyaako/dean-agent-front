"""The fifteen approved backend entities and storage safeguards."""

from pathlib import Path

from alembic import op


revision = "0002_agent_backend"
down_revision = "0001_deanery"
branch_labels = None
depends_on = None


def upgrade():
    sql = Path(__file__).resolve().parents[1] / "sql" / "004_agent_backend.sql"
    op.get_bind().exec_driver_sql(sql.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Удаление сохранённых сессий, предложений и файлов требует отдельного решения")
