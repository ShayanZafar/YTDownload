#!/bin/sh
# macOS: double-click this in Finder to start the YouTube Audio Extractor (app.sh start, in
# Terminal). Keep that Terminal window open while you use the app; closing it stops the app.
cd "$(dirname "$0")" && exec sh ./app.sh start "$@"
