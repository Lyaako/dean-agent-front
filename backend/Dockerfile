FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 LANGSMITH_TRACING=false
WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt && pip check
COPY backend/ /app/backend/
COPY alembic.ini /app/alembic.ini
COPY references/database/03_seed.sql /app/references/database/03_seed.sql
COPY deploy/run_service.py deploy/setup_database.py /app/deploy/
RUN useradd --uid 10001 --no-create-home app
USER 10001:10001
CMD ["python", "/app/deploy/run_service.py", "api"]
