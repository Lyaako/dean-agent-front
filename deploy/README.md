# Local P13 packaging

For a clean clone, use [docs/GETTING_STARTED.md](../docs/GETTING_STARTED.md). It provides an explicit local HTTP override, generates new private files, uses the official pinned Qdrant image and performs fresh model calibration. The detailed HTTPS procedure below and its three-account acceptance records describe the historical11 October instance; the current fresh synthetic seed creates passwords for all five existing roles. Never reuse bootstrap/seed on an existing database.

P13 local acceptance is complete (11 October2026). Source HTTPS8443 runs at `0039_scope_check_latency`, with71 application tables, four live workers and the accepted Qwen3.5/BGE/Qdrant profile. Exact backup/restore of72 tables, owners/effectiveACL/sequences/11 original and derived files, restored reindex/retrieval and HTTPS8444 smoke passed; that separate restore instance is retained and stopped. Final app/parser images match112/34 permitted workspace files at UID10001 with no extra files/secrets; the existing proxy contains the tested React build. Earlier observations below are retained as setup history. Use Compose 2.24 or newer (`!reset` and optional dependencies), from the repository root, always with the explicit project and all three files in this order:

```powershell
$p13Compose = @('-p', 'deanery-p13', '--env-file', '.local/p13-deploy-compose.env', '-f', 'compose.files.yaml', '-f', 'compose.knowledge.yaml', '-f', 'compose.yaml')
docker compose @p13Compose config --quiet
```

The only published port is `127.0.0.1:8443`, with browser origin `https://localhost:8443`. Verify that port is free before launch. PostgreSQL and the new private Qdrant index have project-scoped volumes. File and health storage are separate ignored directory mounts with automatic path creation disabled. Proxy receives only static assets, nginx configuration, and TLS; it receives no database or document mounts. Raw proxy access/error logs are disabled to avoid logging request query strings; startup/health failures and allowlisted application logs provide diagnostics. API mounts only its own database credential, plus agent model settings for bounded metadata/capabilities checks.

The accepted Docker routes are `http://host.docker.internal:1234/v1` (LM Studio) and `http://host.docker.internal:8087` (the existing official BGE service); source Qdrant is private. Qwen3.5-9B Q4_K_M runs with context20480/parallel1/temperature0.6/reasoning_effort=none/max_tokens1536. Both exact native calibrations used13 tools/3909input/0reasoning tokens, static budget4165. Canonical fingerprints: host `a676c2d9d27aa3bea5a34f3b895828bb967b8aee82bb9a6c7eaac75ba3f75e34`; Docker `e87f435ee2f6ff7f4ca1df7c5ca68a8bb82bd11687d88b018ffc8b486b16fa9e`. Their immutable private evidence is `.local/p12-parity-candidate-24865f67-calibration.json` and `...-5bb7e2ec-calibration.json`. A changed model/tool/context/address requires a new real calibration. The task-local TLS certificate has localhost SAN and no global truststore changes.

For the already initialized instance, make the approved model and existing BGE available, then resume only the named services:

```powershell
docker compose @p13Compose up -d --wait --no-deps db qdrant
docker compose @p13Compose run --rm --no-deps migrate
docker compose @p13Compose --profile agent-start up -d --no-deps api agent-worker file-worker knowledge-worker order-worker proxy
```

Use `up --no-deps` here: a plain `start` requires the completed migration dependency container, whereas the explicit one-shot migrator is removed. This sequence retains the existing DB/files and does not bootstrap, provision or seed again. Forms readiness and all eight capability statuses must return ready. The fresh-empty setup below is a separate operation.


After the root build/runtime gates, create the four private directories named in `deployment.env.example`, and their `originals`, `derived`, `temporary`, `regulations` file subdirectories and `agent`, `file`, `knowledge`, `order` health subdirectories. Writers create their private `.staging` directory inside `originals` or `regulations`, so atomic publication stays within the same mount; workers retain read-only originals. Confirm the mounted directories are writable by UID10001 where required. Copy the example to `.local/p13-deploy-compose.env`. Fill `KNOWLEDGE_BGE_URL` only with the root-approved reachable URL to the existing official BGE container. The `knowledge-start` profile is reserved for a coordinated cold start, and must never be used while another BGE instance is running.

Supply a certificate and private key in the private TLS directory as `cert.pem` and `key.pem`, with localhost in the certificate SAN. A task-local self-signed certificate needs an explicit test-context TLS exception; it does not establish public trust. Do not edit truststores, hosts, global firewall, LAN binding, or LM Studio binding.

Administrator JSON is created privately as `admin.json` inside the secret directory, with exactly `host`, `port`, `dbname`, `user`, `password`: host `db`, port5432, database `deanery_p13`, user `postgres`, and a newly generated random password. The same password is provided as a private `postgres-password` file for temporary PostgreSQL initialization; it is not supplied on the command line. The setup profile alone mounts administrator JSON. Runtime logins are generated independently with NOINHERIT and without administrator privileges.

The guarded setup order, after explicit runtime authorization, is:

```powershell
# Phase 1: prove the exact new project's PG volume is absent; any existing volume is a stop.
$p13Existing = docker volume ls --filter 'name=^deanery-p13_postgres_data$' --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the private PostgreSQL volume identity' }
if ($p13Existing) { throw 'New initialization refuses an existing private PostgreSQL volume' }
# The official entrypoint performs initialization with the password mounted temporarily.
docker compose @p13Compose -f deploy/bootstrap.compose.yaml up -d --wait db
# --no-deps prevents setup jobs from changing the temporary database service configuration.
docker compose @p13Compose run --rm --no-deps bootstrap
docker compose @p13Compose run --rm --no-deps migrate
docker compose @p13Compose run --rm --no-deps provision
# Explicit synthetic acceptance only; omit when deploying real data.
docker compose @p13Compose run --rm --no-deps synthetic-seed
# Phase 2: replace only this database container, preserving initialized PGDATA.
docker compose @p13Compose up -d --wait --force-recreate db
```

The main runtime database invokes `postgres` directly and has no administrator secret mount or password environment. An empty runtime PGDATA fails closed. The temporary override is never part of runtime startup. Before starting application services, inspect the recreated owned database container and prove that its mounts/environment contain no `postgres-password`/`POSTGRES_PASSWORD_FILE`; verify its persisted DB/head identity. Source rendering proves the intended two configurations, while only the later runtime check can prove actual removal.

Bootstrap refuses a database with application tables and an existing migration credential file. Migration uses the existing full Alembic chain through the current source head. Runtime setup requires head/table-count checks and new credential files, then invokes the existing narrow provisioners; it does not duplicate their grants. A partial failure is examined before invoking individual missing provisioners; do not delete credentials or rerun setup blindly. Synthetic seed refuses existing application data and generates private login passwords for three existing admin/staff/student accounts in `acceptance-logins.json`. Original seed password placeholders are unusable for application login. Never print or commit private logins, operator tokens, TLS keys, or connection files.

The first acceptance seed reached a wrong account-selection relation (`deanery.role` instead of `deanery.app_role`) after the original seed's own COMMIT. I153 corrected that one query and rebuilt only the application image. Read-only inventory confirmed all71 table counts and all eight original synthetic password placeholders before a bounded private recovery completed only the three intended account passwords. The seed and six runtime-role provisioners were not rerun. The private recovery script belongs to this inspected acceptance instance; it is not a general resume option. Do not treat a failed seed command as proof that its data rolled back.

Private `agent.env` now uses the accepted Qwen3.5 Docker calibration above. Keep prior config when changing it; the API only performs bounded metadata/capabilities probes and cannot execute agent jobs. Do not copy the host URL fingerprint or guess a replacement.

The new application and parser images contain `GET /api/v1/health/ready` (forms DB/schema only) and `python -m backend.service_status check-marker <service>` with the agreed45s marker age. Each worker writes only `/run/health/<service>/status.json`; API mounts all four directories read-only. Offline missing-marker checks correctly exit1. All four live workers and eight capability statuses passed actual readiness. Stopping the four workers makes their45s markers expire while forms remain ready; restart restores capabilities. Future order/job contents and order audit were unchanged.

Launch only the services assigned by the root resource gate. API waits for migration success; proxy waits for forms readiness; model availability does not control forms readiness. Start `agent-worker` explicitly only after model calibration. Start no generic `up` before the gate. Existing file/knowledge parser limits and BGE3GiB/2CPU remain unchanged: the sum of service limits is not proof of host capacity. Obtain measured memory and HTTPS/cookie/SSE checks before acceptance.

Operator commands use only `operator.json`, a privately saved authorized administrator application token in `operator-token.txt`, and the regulations mount. Invoke the existing CLI via `docker compose @p13Compose run --rm operator python -m backend.regulations <existing CLI arguments>`; no actor-ID bypass or database administrator token belongs here.

Rollback is to stop only the named new `deanery-p13` project services and retain its private volumes/files for investigation. Never use volume deletion, broad prune, or cleanup against another project. Backup/isolated restore/reindex/HTTPS and process restart have passed; exact evidence and the original failed attempts remain in IMPLEMENTATION_STATUS.md and the private packets.

Historical I159/I164 preparation: acceptance fixtures include an exact protected attachment/complete derivative, a pending document proposal, and a separately confirmed scheduled future order/job. A readable UTF8 normative version was officially published through the existing BGE/private Qdrant after the initial malformed synthetic version; the malformed version was officially withdrawn and its immutable history retained. Actual Russian/English characters, source/derivative hashes and the publication receipt are verified, without an LLM/citation claim. Before recovery handoff, every owned access was logged out, all agent runs ended and no job was running. New file/knowledge workers were stopped after their staged jobs for host RAM; order/agent daemons were not started. Root owns the subsequent writer freeze, consistent snapshot and isolated restore acceptance.
