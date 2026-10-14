"""Backend-owned password policy and private account operations."""
from pathlib import Path
from alembic import op

revision = "0041_account_security"
down_revision = "0040_database_revision"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "033_account_security.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve password policy and account operation history; use a forward repair")
