"""P00: guard the pinned inputs before introducing backend migrations."""

import hashlib
import json
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads(
    (Path(__file__).parent / "fixtures" / "source_contract.json").read_text(
        encoding="utf-8"
    )
)
FRONTEND_CONTRACT = json.loads(
    (Path(__file__).parent / "fixtures" / "frontend_contract.json").read_text(encoding="utf-8")
)


def sql_without_comments(path: str) -> str:
    sql = (ROOT / path).read_text(encoding="utf-8")
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return re.sub(r"--[^\n]*", "", sql)


class SourceContractTests(unittest.TestCase):
    def test_frontend_contract_covers_every_existing_data_tab_and_display_column(self):
        frontend = ROOT / "references/frontend-source/frontend/src"
        tabs = (frontend / "pages/tabs.ts").read_text(encoding="utf-8")
        views = set(re.findall(r'view: "(\w+)"', tabs))
        self.assertEqual(views, {screen["view"] for screen in FRONTEND_CONTRACT["screens"]})
        self.assertEqual(FRONTEND_CONTRACT["frontend_commit"], MANIFEST["frontend"]["commit"])
        columns = (frontend / "pages/columns.tsx").read_text(encoding="utf-8")
        for screen in FRONTEND_CONTRACT["screens"]:
            with self.subTest(screen=screen["id"]):
                block = re.search(r"export const " + screen["columns_export"] + r"[^=]*= \[([\s\S]*?)\n\];", columns)
                self.assertIsNotNone(block)
                required = set(re.findall(r'field:\s*"(\w+)"', block.group(1))) | set(re.findall(r"\br\.(\w+)", block.group(1))) | set(screen["key"])
                self.assertEqual(required, set(screen["required_view_fields"]))
                source = (frontend / screen["source"]).read_text(encoding="utf-8")
                order = re.search(r"order:\s*\[([^\]]*)\]", source)
                self.assertEqual(re.findall(r'"(\w+)"', order.group(1)), screen["form_fields"])
                self.assertIn(screen["view"], source)
                self.assertIn(screen["table"], source)

    def test_frontend_contract_keeps_all_explicit_lookup_sources_and_own_staff_reads(self):
        frontend = ROOT / "references/frontend-source/frontend/src"
        source = (frontend / "components/form/lookups.ts").read_text(encoding="utf-8")
        self.assertEqual(set(re.findall(r'fetchAll\("(\w+)"', source)), set(FRONTEND_CONTRACT["lookup_fields"]))
        requests = (frontend / "pages/RequestsPage.tsx").read_text(encoding="utf-8")
        self.assertIn('getRow("employee", { person_id:', requests)
        self.assertIn('getRow("dean_office_staff", { employee_id:', requests)
        employee = (frontend / "pages/EmployeesPage.tsx").read_text(encoding="utf-8")
        for field in FRONTEND_CONTRACT["linked_employee_fields"]["fields"]:
            self.assertIn('"' + field + '"', employee)

    def test_migration_preserves_original_schema_without_the_destructive_reset(self):
        original = sql_without_comments("references/database/01_schema.sql")
        frozen = sql_without_comments("backend/db/migrations/sql/001_schema.sql")
        expected = original.replace("DROP SCHEMA IF EXISTS deanery CASCADE;", "")
        self.assertEqual(frozen.split(), expected.split())
        self.assertEqual(
            (ROOT / "backend/db/migrations/sql/002_views_functions.sql").read_bytes(),
            (ROOT / "references/database/02_views_functions.sql").read_bytes(),
        )

    def test_legacy_permissions_have_no_demonstration_login(self):
        original = sql_without_comments("references/database/05_roles_security.sql")
        frozen = sql_without_comments("backend/db/migrations/sql/003_roles_security.sql")
        expected = original.replace(
            "CREATE ROLE deanery_agent LOGIN PASSWORD 'change_me_agent' CONNECTION LIMIT 20;",
            "CREATE ROLE deanery_agent NOLOGIN;",
        )
        self.assertEqual(frozen.split(), expected.split())
        self.assertNotIn("change_me_agent", frozen)

    def test_pinned_reference_files_are_unchanged(self):
        for relative_path, expected_hash in MANIFEST["files"].items():
            with self.subTest(path=relative_path):
                actual_hash = hashlib.sha256((ROOT / relative_path).read_bytes()).hexdigest()
                self.assertEqual(actual_hash, expected_hash)

    def test_frontend_version_matches_the_approved_branch(self):
        source = json.loads(
            (ROOT / "references/frontend-source/source.json").read_text(encoding="utf-8")
        )
        self.assertEqual(source["repository"], MANIFEST["frontend"]["repository"])
        self.assertEqual(source["branch"], MANIFEST["frontend"]["branch"])
        self.assertEqual(source["commit"], MANIFEST["frontend"]["commit"])

    def test_catalog_preserves_the_original_schema(self):
        catalog = json.loads(
            (ROOT / "docs/resource-catalog.json").read_text(encoding="utf-8")
        )
        expected = MANIFEST["database"]
        schema = sql_without_comments("references/database/01_schema.sql")
        tables = re.findall(r"\bCREATE\s+TABLE\s+(\w+)", schema, flags=re.I)
        self.assertEqual(len(tables), expected["tables"])
        self.assertEqual(len(set(tables)), len(tables))
        self.assertEqual(set(tables), {table["name"] for table in catalog["tables"]})
        self.assertEqual(len(catalog["tables"]), expected["tables"])
        self.assertEqual(
            sum(len(table["fields"]) for table in catalog["tables"]),
            expected["columns"],
        )
        self.assertEqual(
            len(re.findall(r"\bREFERENCES\s+", schema, flags=re.I)),
            expected["foreign_keys"],
        )
        views = re.findall(
            r"\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(\w+)",
            sql_without_comments("references/database/02_views_functions.sql"),
            flags=re.I,
        )
        self.assertEqual(len(views), expected["views"])
        self.assertEqual(set(views), set(catalog["views"]))

    def test_workflow_procedures_required_by_the_plan_exist(self):
        functions = sql_without_comments("references/database/02_views_functions.sql")
        names = set(
            re.findall(
                r"\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(\w+)",
                functions,
                flags=re.I,
            )
        )
        self.assertTrue(set(MANIFEST["required_routines"]).issubset(names))


if __name__ == "__main__":
    unittest.main()
