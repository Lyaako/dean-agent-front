"""OLAP dataset fields for the session, risk and retake metrics."""
from pathlib import Path
from alembic import op

revision = "0060_olap_metrics"
down_revision = "0059_retake_roster_group"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "052_olap_metrics.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the OLAP metric fields")
