"""Add author submission and source-manager correction decisions to shared proposals."""
from pathlib import Path
from alembic import op
revision = '0025_correction_proposals'
down_revision = '0024_agent_commands'
branch_labels = None
depends_on = None

def upgrade():
    folder = Path(__file__).resolve().parents[1] / 'sql'
    for name in ('018_special_commands.sql','020_correction_proposals.sql','014_proposals.sql','014_prepare_proposal.sql'):
        op.get_bind().exec_driver_sql((folder/name).read_text(encoding='utf-8-sig'),execution_options={'no_parameters':True})

def downgrade():
    raise RuntimeError('Поданные заявки и решения сохраняются; используйте прямую исправляющую миграцию')
