"""Reject SQL/JSON nulls that must not bypass proposal state checks."""

from alembic import op


revision = "0003_storage_checks"
down_revision = "0002_agent_backend"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("""ALTER TABLE agent_backend.proposal
        ADD CONSTRAINT proposal_execution_status_string
            CHECK (jsonb_typeof(execution->'status') = 'string'),
        ADD CONSTRAINT proposal_correction_requires_submission
            CHECK (correction_id IS NULL OR submission_status IS NOT DISTINCT FROM 'submitted')""")


def downgrade():
    raise RuntimeError("Ослабление проверок состояния предложения требует отдельного решения")
