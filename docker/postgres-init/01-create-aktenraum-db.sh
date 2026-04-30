#!/usr/bin/env bash
# Postgres only runs files under /docker-entrypoint-initdb.d on a fresh data
# directory. For existing installs, the operator must run the equivalent
# `CREATE DATABASE` once by hand (see docs/runbooks/operations.md).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE aktenraum OWNER ${POSTGRES_USER}'
    WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'aktenraum')\gexec
EOSQL
