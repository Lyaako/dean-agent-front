"""Decision comments, transfer reasons, redo, selected undo with reasons and the event journal."""
from pathlib import Path
from alembic import op

revision = "0057_decision_contract"
down_revision = "0056_read_boundaries"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "049_decision_contract.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Keep the revised decision contract")
