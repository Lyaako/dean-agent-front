"""Private originals and durable bounded extraction, without new tables."""
from pathlib import Path
from alembic import op
revision = '0028_files'
down_revision = '0027_special_fixes'
branch_labels = None
depends_on = None


def upgrade():
    path = Path(__file__).resolve().parents[1] / 'sql' / '021_files.sql'
    op.get_bind().exec_driver_sql(path.read_text(encoding='utf-8'), execution_options={'no_parameters': True})


def downgrade():
    raise RuntimeError('Originals/history are retained; use a forward repair')
