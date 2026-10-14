"""Serialize password verification and update in one request transaction."""
from pathlib import Path
from alembic import op

revision = "0055_password_lock"
down_revision = "0054_read_context"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "047_password_lock.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep password verification serialized with its update")
