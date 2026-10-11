#!/usr/bin/env sh
# Linux: stops the YouTube Audio Extractor (scripts/unix/app.sh stop).
exec sh "$(dirname "$0")/scripts/unix/app.sh" stop "$@"
