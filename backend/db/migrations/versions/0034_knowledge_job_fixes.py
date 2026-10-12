"""Expose exhausted knowledge leases without losing a published generation."""
from pathlib import Path
from alembic import op

revision = '0034_knowledge_job_fixes'
down_revision = '0033_regulation_citations'
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / 'sql' / '027_knowledge_job_fixes.sql'
    op.get_bind().exec_driver_sql(path.read_text(encoding='utf-8'), execution_options={'no_parameters': True})


def downgrade():
    raise RuntimeError('Knowledge job history is retained; use a forward repair')
