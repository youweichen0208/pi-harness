#!/bin/sh
set -eu

# Existing named volumes do not inherit directories added by a newer image.
# Run as the configured node user; never change ownership of mounted data.
mkdir -p /data/omp-native
exec /usr/local/bin/docker-entrypoint.sh "$@"
