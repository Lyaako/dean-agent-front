"""Enforce the confirmed contact and new scholarship date policies."""
from pathlib import Path
from alembic import op

revision = "0038_confirmed_write_policy"
down_revision = "0037_discipline_lookup"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "031_confirmed_write_policy.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Preserve the confirmed write policy; use a forward repair")
