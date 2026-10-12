"""Current normative evidence shares the existing run and finalization gates."""
from pathlib import Path
from alembic import op

revision = "0033_regulation_citations"
down_revision = "0032_regulations"
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / "sql" / "026_regulation_citations.sql"
    op.get_bind().exec_driver_sql(path.read_text(encoding="utf-8"), execution_options={"no_parameters": True})


def downgrade():
    raise RuntimeError("Normative provenance is retained; use a forward repair")
