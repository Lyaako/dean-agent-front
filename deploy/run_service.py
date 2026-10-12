"""Read one mounted private connection; launch the existing API or order worker."""
import argparse
import json
import os
from pathlib import Path
import sys

from psycopg.conninfo import make_conninfo
from psycopg import ProgrammingError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('service', choices=('api', 'order'))
    args = parser.parse_args()
    try:
        parameters = json.loads(Path('/run/secrets/database.json').read_text(encoding='utf-8'))
        if set(parameters) != {'host', 'port', 'dbname', 'user', 'password'}:
            raise ValueError('connection_fields')
        if (any(not isinstance(parameters[name], str) or not parameters[name] for name in ('host', 'dbname', 'user', 'password'))
                or type(parameters['port']) is not int or not 1 <= parameters['port'] <= 65535):
            raise ValueError('connection_values')
        dsn = make_conninfo(**parameters)
    except (OSError, ValueError, TypeError, ProgrammingError):
        raise SystemExit('Private database connection is missing or invalid') from None
    variable = 'DATABASE_URL' if args.service == 'api' else 'WORKER_DATABASE_URL'
    os.environ[variable] = dsn
    command = ([sys.executable, '-m', 'uvicorn', 'backend.app:app', '--host', '0.0.0.0',
                '--port', '8000', '--no-access-log'] if args.service == 'api'
               else [sys.executable, '-m', 'backend.order_worker'])
    os.execv(sys.executable, command)


if __name__ == '__main__':
    main()
