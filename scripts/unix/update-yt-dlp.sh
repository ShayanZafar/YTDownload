#!/usr/bin/env sh
# Gets the newest yt-dlp, the part of the app that talks to YouTube (app.sh update-yt-dlp).
# Run it when YouTube downloads stop working: YouTube changes things now and then.
exec sh "$(dirname "$0")/app.sh" update-yt-dlp "$@"
