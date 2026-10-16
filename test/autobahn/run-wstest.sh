#!/bin/sh
set -e

# Runs the Autobahn fuzzing client against the server on port 8080.
# Run the server first, for example with `pnpm server`.
cd "$(dirname "$0")"

# No -it, so it also runs without a terminal (CI). --add-host makes
# host.docker.internal resolve on Linux too; Docker Desktop already has it.
docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -v "${PWD}/config:/config" \
    -v "${PWD}/reports:/reports" \
    --name fuzzingclient \
    crossbario/autobahn-testsuite \
    wstest -m fuzzingclient --spec /config/fuzzingclient.json
