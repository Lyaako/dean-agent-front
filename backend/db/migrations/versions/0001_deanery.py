"""Preserve the supplied deanery schema, routines and legacy permission tests."""

from pathlib import Path

from alembic import op


revision = "0001_deanery"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    directory = Path(__file__).resolve().parents[1] / "sql"
    for name in ("001_schema.sql", "002_views_functions.sql", "003_roles_security.sql"):
        op.get_bind().exec_driver_sql(
            (directory / name).read_text(encoding="utf-8"),
            execution_options={"no_parameters": True},
        )


def downgrade():
    raise RuntimeError("Удаление предметной схемы не входит в безопасную миграцию; требуется отдельное решение")
