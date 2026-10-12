"""Private scholarship/correction/cancellation commands; preserve source procedures."""
from pathlib import Path
from alembic import op
revision = '0023_special_commands'
down_revision = '0022_agent_reads'
branch_labels = None
depends_on = None

def upgrade():
    folder = Path(__file__).resolve().parents[1] / 'sql'
    op.get_bind().exec_driver_sql((folder / '018_special_commands.sql').read_text(encoding='utf-8-sig'), execution_options={'no_parameters': True})

def downgrade():
    raise RuntimeError('Остановите специальные инструменты и worker; история требует прямой исправляющей миграции')
