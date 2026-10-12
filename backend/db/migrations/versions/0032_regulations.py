"""Private normative originals, immutable chunks and atomic index publication."""
from pathlib import Path
from alembic import op

revision = '0032_regulations'
down_revision = '0031_run_attachment_fixes'
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / 'sql' / '025_regulations.sql'
    op.get_bind().exec_driver_sql(path.read_text(encoding='utf-8'), execution_options={'no_parameters': True})


def downgrade():
    raise RuntimeError('Normative originals and audit are retained; use a forward repair')
