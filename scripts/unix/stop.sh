#!/usr/bin/env sh
# Stops the YouTube Audio Extractor, however it was started (app.sh stop).
exec sh "$(dirname "$0")/app.sh" stop "$@"
