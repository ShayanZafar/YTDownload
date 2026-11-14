#!/usr/bin/env sh
# Linux: updates the YouTube Audio Extractor to the newest build (scripts/unix/app.sh update).
exec sh "$(dirname "$0")/scripts/unix/app.sh" update "$@"
