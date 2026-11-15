#!/usr/bin/env sh
# Linux: starts the YouTube Audio Extractor (scripts/unix/app.sh start). Run it from a terminal.
exec sh "$(dirname "$0")/scripts/unix/app.sh" start "$@"
