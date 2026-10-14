"""Current cohort reads, scoped audit and successful decision replay."""
from pathlib import Path
from alembic import op

revision = "0056_read_boundaries"
down_revision = "0055_password_lock"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "048_read_boundaries.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep revised resource boundaries")
