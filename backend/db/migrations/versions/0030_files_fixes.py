"""Reserve upload attempts before publication and retry transient file failures."""
from pathlib import Path
from alembic import op
revision = '0030_files_fixes'
down_revision = '0029_run_attachments'
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / 'sql' / '023_files_fixes.sql'
    op.get_bind().exec_driver_sql(path.read_text(encoding='utf-8'), execution_options={'no_parameters': True})


def downgrade():
    raise RuntimeError('File evidence is retained; use a forward repair')
