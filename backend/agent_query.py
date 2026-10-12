"""Parse a small SELECT language and substitute authorized, typed row sources."""

import re
from uuid import UUID

from pglast import ast, parse_sql
from pglast.stream import RawStream


class QueryRejected(ValueError):
    pass


NODES = {"SelectStmt", "ResTarget", "RangeVar", "Alias", "JoinExpr", "ColumnRef",
         "A_Const", "Integer", "Float", "String", "Boolean", "A_Expr", "BoolExpr",
         "NullTest", "BooleanTest", "FuncCall", "SortBy", "TypeCast", "TypeName",
         "CaseExpr", "CaseWhen", "CoalesceExpr", "MinMaxExpr", "SQLValueFunction"}
FUNCTIONS = {"count", "sum", "avg", "min", "max", "round", "abs", "lower", "upper",
             "length", "char_length", "date_part", "date_trunc"}
OPERATORS = {"=", "<>", "<", ">", "<=", ">=", "+", "-", "*", "/", "%", "~~", "!~~", "~~*", "!~~*"}
TYPES = {"int2", "int4", "int8", "numeric", "float4", "float8", "text", "varchar",
         "bpchar", "bool", "date", "timestamp", "timestamptz", "interval"}


def _walk(value):
    if isinstance(value, ast.Node):
        yield value
        for slot in value:
            yield from _walk(getattr(value, slot))
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _walk(item)


def _integer(value, minimum, maximum):
    return (isinstance(value, ast.A_Const) and isinstance(value.val, ast.Integer)
            and minimum <= value.val.ival <= maximum)


def _ident(value):
    return '"' + value.replace('"', '""') + '"'


def rewrite_query(query: str, specs: dict, run_id: UUID, worker_id: UUID) -> str:
    """Only metadata from resources.spec may be passed as specs, never model metadata."""
    if not isinstance(query, str) or not 1 <= len(query) <= 6000:
        raise QueryRejected("query_length")
    try:
        statements = parse_sql(query)
    except Exception:
        raise QueryRejected("invalid_sql") from None
    if len(statements) != 1 or not isinstance(statements[0].stmt, ast.SelectStmt):
        raise QueryRejected("select_required")
    root = statements[0].stmt
    if (not _integer(root.limitCount, 1, 60) or root.limitOption.name != "LIMIT_OPTION_COUNT"
            or (root.limitOffset and not _integer(root.limitOffset, 0, 100000))):
        raise QueryRejected("limit_required")
    nodes = list(_walk(root))
    aliases = {}
    for node in nodes:
        if type(node).__name__ not in NODES:
            raise QueryRejected("unsupported_expression")
        if isinstance(node, ast.SelectStmt):
            # shortcut: no nested SELECT/CTE/set operations; add scoped name resolution before enabling them.
            if node is not root or any((node.intoClause, node.lockingClause, node.withClause,
                                       node.valuesLists, node.windowClause, node.larg, node.rarg)):
                raise QueryRejected("unsupported_select")
        elif isinstance(node, ast.RangeVar):
            if node.catalogname or node.schemaname not in (None, "deanery") or node.relname not in specs:
                raise QueryRejected("resource_forbidden")
            if node.alias and node.alias.colnames:
                raise QueryRejected("column_aliases_forbidden")
            name = node.alias.aliasname if node.alias else node.relname
            if name in aliases:
                raise QueryRejected("duplicate_alias")
            aliases[name] = specs[node.relname]
        elif isinstance(node, ast.JoinExpr):
            if node.alias or node.isNatural or node.usingClause:
                raise QueryRejected("explicit_join_required")
        elif isinstance(node, ast.SortBy):
            if node.useOp:
                raise QueryRejected("operator_forbidden")
        elif isinstance(node, ast.FuncCall):
            names = [part.sval for part in node.funcname]
            if (len(names) != 1 or names[0] not in FUNCTIONS or node.over or node.agg_order
                    or node.agg_within_group or node.func_variadic or (node.agg_star and names != ["count"])):
                raise QueryRejected("function_forbidden")
            node.funcname = (ast.String(sval="pg_catalog"), *node.funcname)
        elif isinstance(node, ast.A_Expr):
            if len(node.name or ()) != 1 or node.name[0].sval not in OPERATORS:
                raise QueryRejected("operator_forbidden")
        elif isinstance(node, ast.TypeName):
            names = [part.sval for part in node.names or ()]
            if (not names or names[-1] not in TYPES or len(names) > 2 or
                    (len(names) == 2 and names[0] != "pg_catalog") or node.arrayBounds or node.setof):
                raise QueryRejected("type_forbidden")
        elif isinstance(node, ast.SQLValueFunction):
            if node.op.name not in {"SVFOP_CURRENT_DATE", "SVFOP_CURRENT_TIMESTAMP"}:
                raise QueryRejected("value_function_forbidden")
    if not aliases:
        raise QueryRejected("resource_required")
    output_names = {target.name for target in root.targetList if target.name}
    order_refs = {id(item.node) for item in root.sortClause or ()}
    for node in nodes:
        if isinstance(node, ast.ColumnRef):
            if any(not isinstance(part, ast.String) for part in node.fields):
                raise QueryRejected("explicit_fields_required")
            names = [part.sval for part in node.fields]
            if len(names) == 2:
                allowed = names[0] in aliases and names[1] in aliases[names[0]].read_fields
            elif len(names) == 1:
                allowed = sum(names[0] in info.read_fields for info in aliases.values()) == 1
                allowed |= id(node) in order_refs and names[0] in output_names
            else:
                allowed = False
            if not allowed:
                raise QueryRejected("column_forbidden_or_ambiguous")

    def replace(value):
        if isinstance(value, ast.RangeVar):
            info = specs[value.relname]
            columns = []
            for name in info.read_fields:
                sql_type = info.fields[name].type
                # Catalog metadata is trusted, but never interpolate a user-defined SQL type.
                if not re.fullmatch(r"(?:smallint|integer|bigint|boolean|text|date|real|double precision|jsonb?|numeric(?:\(\d+,\d+\))?|character(?: varying)?(?:\(\d+\))?|timestamp(?:\(\d+\))? (?:with|without) time zone|time(?:\(\d+\))? without time zone|interval)", sql_type):
                    raise QueryRejected("unsupported_column_type")
                columns.append(f"{_ident(name)} {sql_type}")
            alias = value.alias.aliasname if value.alias else value.relname
            source = (f"SELECT {','.join(_ident(name) for name in info.read_fields)} "
                      f"FROM backend_api.agent_visible_rows('{UUID(str(run_id))}', '{UUID(str(worker_id))}', "
                      f"'{value.relname}') AS authorized(row_data) "
                      f"CROSS JOIN LATERAL jsonb_to_record(authorized.row_data::jsonb) AS typed({','.join(columns)})")
            return ast.RangeSubselect(subquery=parse_sql(source)[0].stmt, alias=ast.Alias(aliasname=alias))
        if isinstance(value, ast.Node):
            for slot in value:
                current = getattr(value, slot)
                if isinstance(current, (ast.Node, tuple, list)):
                    setattr(value, slot, replace(current))
        elif isinstance(value, (tuple, list)):
            return tuple(replace(item) for item in value)
        return value

    return RawStream()(replace(root))
