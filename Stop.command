#!/bin/sh
# macOS: double-click to stop the YouTube Audio Extractor (scripts/unix/app.sh stop).
cd "$(dirname "$0")" && exec sh scripts/unix/app.sh stop "$@"
