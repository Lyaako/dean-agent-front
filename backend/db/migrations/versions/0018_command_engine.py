"""Reuse domain executors for isolated previews and approved commands."""

from pathlib import Path
from alembic import op

revision = "0018_command_engine"
down_revision = "0017_order_job_status"
branch_labels = None
depends_on = None


def upgrade():
    root = Path(__file__).resolve().parents[1] / "sql"
    sql = (root / "008_manual_mutations.sql").read_text(encoding="utf-8")
    workflows = (root / "010_workflows.sql").read_text(encoding="utf-8")
    sql += workflows[workflows.index("CREATE FUNCTION backend_api.run_workflow_as("):]
    worker = (root / "011_order_worker.sql").read_text(encoding="utf-8")
    sql += worker[worker.index("CREATE FUNCTION backend_api.perform_order_job("):]
    sql = sql.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION")
    sql += (root / "013_command_engine.sql").read_text(encoding="utf-8")
    op.get_bind().exec_driver_sql(sql, execution_options={"no_parameters": True})


def downgrade():
    op.execute("DROP TRIGGER command_capture_audit ON deanery.audit_log")
    op.execute("DROP FUNCTION backend_api.command_capture_audit()")
    op.execute("DROP FUNCTION backend_api.command_expected(INT,INT)")
    for signature in (
        "command_preview(JSONB,INT,INT)", "command_execute(JSONB,INT,INT,INT,UUID)",
        "command_snapshot(JSONB,INT)", "command_dependencies(TEXT,JSONB,JSONB,BOOLEAN)",
        "command_lock(JSONB)", "command_relations(JSONB)", "command_authorized(JSONB,INT,TEXT,INT)",
        "command_institute(JSONB)", "command_row(JSONB)", "command_normalize(JSONB,INT)",
    ):
        op.execute("DROP FUNCTION backend_api." + signature)
