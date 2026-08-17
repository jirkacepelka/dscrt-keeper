#!/bin/sh
#
# Take ownership of the data volume, then stop being root.
#
# The keeper wants to run as an unprivileged user — it holds a signing key, and the less it
# can reach the better. It also has to write to a volume that the host created, and on
# ZimaOS that volume is `/DATA/AppData/<app>`, owned by root. A container that ran as `node`
# from the first instruction would find its own data directory unwritable and carry on
# looking perfectly healthy while keeping no history and saving no settings.
#
# So: start as root, fix the one directory, drop. The window in which this process is
# privileged is two commands long and contains no network access and no key.
#
# If the image is already started as an unprivileged user — `docker run --user`, or a
# platform that insists — this does nothing and execs straight through. The console will
# then say the directory is not writable rather than pretending otherwise.
set -e

DATA="${KEEPER_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  # Best effort. A read-only bind, or a filesystem with no ownership concept, is not a
  # reason to refuse to start — the keeper still reads the protocol and still reports.
  chown -R node:node "$DATA" 2>/dev/null || true
  chmod 700 "$DATA" 2>/dev/null || true
  exec su-exec node "$@"
fi

exec "$@"
