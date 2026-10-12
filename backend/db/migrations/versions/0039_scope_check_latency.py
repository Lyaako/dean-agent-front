"""Avoid repeated JIT compilation in the live permission signature check."""
from alembic import op

revision = "0039_scope_check_latency"
down_revision = "0038_confirmed_write_policy"
branch_labels = None
depends_on = None


def upgrade():
    # Compilation dominated this frequent check and starved live SSE/worker leases.
    op.execute("ALTER FUNCTION agent_backend.scope_signature(INTEGER) SET jit TO off")


def downgrade():
    raise RuntimeError("Preserve the live scope check; use a forward repair")
