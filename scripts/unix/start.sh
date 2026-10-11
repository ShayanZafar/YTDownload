#!/usr/bin/env sh
# Starts the YouTube Audio Extractor and opens it in your browser (app.sh start). Keep this
# terminal open while you use the app: Ctrl+C stops it, and so does stop.sh.
#   start.sh --no-browser    starts it without opening the browser
exec sh "$(dirname "$0")/app.sh" start "$@"
