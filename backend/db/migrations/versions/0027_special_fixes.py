"""Forward repair cancellation local-variable resolution without changing domain procedures."""
from pathlib import Path
from alembic import op
revision = '0027_special_fixes'
down_revision = '0026_scope_reads'
branch_labels = None
depends_on = None

def upgrade():
    folder=Path(__file__).resolve().parents[1]/'sql'
    for name in ('018_special_commands.sql','014_proposals.sql'):
        op.get_bind().exec_driver_sql((folder/name).read_text(encoding='utf-8'),execution_options={'no_parameters':True})

def downgrade():
    raise RuntimeError('Отмена сохраняет историю; используйте прямую исправляющую миграцию')
