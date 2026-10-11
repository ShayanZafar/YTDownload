#!/usr/bin/env sh
# Updates the YouTube Audio Extractor to its newest version (app.sh update): the newest build in
# a copy installed from the install branch, the newest code in a copy of the source. A running
# app is stopped first and started again afterwards.
exec sh "$(dirname "$0")/app.sh" update "$@"
