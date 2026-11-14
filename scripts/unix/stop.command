#!/bin/sh
# macOS: double-click this in Finder to stop the YouTube Audio Extractor (app.sh stop).
cd "$(dirname "$0")" && exec sh ./app.sh stop "$@"
