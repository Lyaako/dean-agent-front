"""Allow the immutable source manager function to resolve its deanery tables."""

from alembic import op


revision = "0005_snapshot_function_path"
down_revision = "0004_auth_access"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER FUNCTION backend_api.account_snapshot(INT) SET search_path TO pg_catalog, deanery")


def downgrade():
    raise RuntimeError("Ослабление функции снимка прав требует отдельного решения")
