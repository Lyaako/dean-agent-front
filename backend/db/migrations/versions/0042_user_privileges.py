"""Run application domain writes as the authenticated user's NOLOGIN role."""
from pathlib import Path
from alembic import op

revision = "0042_user_privileges"
down_revision = "0041_account_security"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "034_user_privileges.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Do not restore owner-privileged domain writes; use a forward repair")
