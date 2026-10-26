#!/usr/bin/env sh
# YouTube Audio Extractor on macOS and Linux: what the scripts next to this file run, so a
# double-click (the .command files, on macOS) or one command does the work. The Windows versions
# are in scripts/windows/ and behave the same.
#
#   app.sh start [--no-browser] [--dev]
#                                Start the app: check it isn't running already, install what it
#                                needs when needed, build a copy of the source code when its code
#                                changed (--dev: run the development server instead), open the
#                                browser once it's up. Keep the terminal open; Ctrl+C stops it.
#   app.sh stop                  Stop the app, however it was started.
#   app.sh update                Get the newest version: the newest build in a copy installed
#                                from the install branch, the newest code in a copy of the source.
#   app.sh update-yt-dlp         Get the newest yt-dlp (when YouTube downloads stop working).
#
# Plain POSIX sh: it runs under macOS's /bin/sh and Debian's dash as well as bash. Keep it ASCII.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
# npm skips what only development needs when NODE_ENV=production, and a copy of the source code
# runs with the development server, so make sure it isn't set.
unset NODE_ENV 2>/dev/null || true
# yt-dlp's installer asks for Python, which the standalone yt-dlp doesn't need.
export YOUTUBE_DL_SKIP_PYTHON_CHECK=1

app_name="YouTube Audio Extractor"
# A ready-to-run build (installed from the install branch) has the built app but not its source.
is_build=false
if [ -f dist/index.cjs ] && [ ! -f server/index.ts ]; then is_build=true; fi

# --- Settings -----------------------------------------------------------------------------------

# A setting from the environment or the app's .env file (the environment wins, as in the app).
setting() {
  eval "value=\${$1:-}"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" .env | head -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//'
}

# Where this computer reaches the app: http://localhost:5000 unless .env says otherwise.
port() {
  p="$(setting PORT)"
  case "$p" in '' | *[!0-9]*) p=5000 ;; esac
  printf '%s' "$p"
}
url() {
  h="$(setting HOST)"
  case "$h" in
    '' | 0.0.0.0 | :: | 127.0.0.1 | ::1 | localhost) h=localhost ;;
    *:*) h="[$h]" ;;
  esac
  printf 'http://%s:%s' "$h" "$(port)"
}

# --- Finding the app ----------------------------------------------------------------------------

# The processes listening on a port (lsof on macOS and most Linux; ss on the rest).
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :$1" 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' || true
  fi
}

# The app's server: Node running server/index.ts (npm run dev) or dist/index.cjs (npm start).
is_server() {
  case "$(ps -o args= -p "$1" 2>/dev/null || true)" in
    *node*server/index.ts* | *node*dist/index.cjs* | *tsx*server/index.ts*) return 0 ;;
  esac
  return 1
}

# The app's servers: answering on the app's port, or started from this folder.
server_pids() {
  for pid in $(port_pids "$(port)"); do
    if is_server "$pid"; then echo "$pid"; fi
  done
  ps -eo pid=,args= 2>/dev/null | awk -v root="$root/" '
    (/server\/index\.ts/ || /dist\/index\.cjs/) && index($0, root) { print $1 }' || true
}

# Part of what started a server: npm, tsx, the start script. Never the terminal it came from.
is_launcher() {
  case "$(ps -o args= -p "$1" 2>/dev/null || true)" in
    *npm* | *tsx* | *node* | *app.sh* | *start.sh* | *start.command* | *Start.command* | *Start.sh*) return 0 ;;
  esac
  return 1
}

# --- Actions ------------------------------------------------------------------------------------

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  else echo "Open $1 in your browser."
  fi
}

# (start, in the background) Waits for the app to answer, then opens it in the browser.
open_when_ready() {
  tries=0
  while [ "$tries" -lt 180 ]; do
    if curl -fsS -m 5 "$1/api/settings" >/dev/null 2>&1; then
      open_url "$1"
      return 0
    fi
    sleep 1
    tries=$((tries + 1))
  done
}

# Packages missing, or package-lock.json changed since they were installed (after an update, say).
needs_install() {
  for file in node_modules/youtube-dl-exec/bin/yt-dlp node_modules/ffmpeg-static/ffmpeg; do
    [ -e "$file" ] || return 0
  done
  if ! $is_build; then [ -e node_modules/.bin/tsx ] || return 0; fi
  [ -f node_modules/.package-lock.json ] || return 0
  [ -f package-lock.json ] || return 1
  [ package-lock.json -nt node_modules/.package-lock.json ]
}

start_app() {
  no_browser=false
  dev=false
  for arg in "$@"; do
    case "$arg" in
      --no-browser) no_browser=true ;;
      --dev) dev=true ;;
    esac
  done
  app_url="$(url)"
  if [ -n "$(server_pids | sort -u)" ]; then
    echo "$app_name is already running: $app_url"
    $no_browser || open_url "$app_url"
    return 0
  fi
  owner="$(port_pids "$(port)" | head -n 1)"
  if [ -n "$owner" ]; then
    echo "Port $(port) is being used by another program ($(ps -o comm= -p "$owner" 2>/dev/null || echo unknown), process $owner)."
    echo "Close that program, or give the app another port: put PORT=5001 in the .env file in $root"
    return 1
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "Node.js isn't installed. Install the LTS version from https://nodejs.org, then start the app again."
    echo "  macOS with Homebrew: brew install node        Debian or Ubuntu: sudo apt install nodejs npm"
    return 1
  fi
  if needs_install; then
    echo "Installing what the app needs (the first time, or after an update) - this takes a minute or two..."
    if $is_build; then npm ci --omit=dev; else npm install; fi
    # Remember this install, so the next start doesn't redo it.
    touch node_modules/.package-lock.json 2>/dev/null || true
  fi
  # A copy of the source code runs its build, which loads quicker than the development server,
  # built again whenever the code changed since.
  if ! $is_build && ! $dev && node scripts/needs-build.mjs; then
    echo "Building the app (its code changed since the last build) - this takes a few seconds..."
    if ! npm run build; then
      echo "Building failed (see above), so the development version starts instead."
      dev=true
    fi
  fi
  if ! $no_browser; then (open_when_ready "$app_url" &); fi
  echo
  echo "Starting $app_name at $app_url"
  echo "Keep this window open while you use it. Ctrl+C (or stop.sh) stops the app."
  echo
  # The built app: a ready-to-run build (installed from the install branch), or the source's build.
  if $dev && ! $is_build; then exec npm run dev; else exec npm start; fi
}

stop_app() {
  pids="$(server_pids | sort -u)"
  if [ -z "$pids" ]; then
    echo "$app_name isn't running."
    return 0
  fi
  for pid in $pids; do
    # Stop what started the server too (npm, tsx), so its terminal command returns.
    top="$pid"
    depth=0
    while [ "$depth" -lt 3 ]; do
      parent="$(ps -o ppid= -p "$top" 2>/dev/null | tr -d ' ' || true)"
      if [ -z "$parent" ] || [ "$parent" = 1 ] || ! is_launcher "$parent"; then break; fi
      top="$parent"
      depth=$((depth + 1))
    done
    kill -TERM "$top" 2>/dev/null || true
    if [ "$top" != "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  sleep 1
  if [ -n "$(server_pids | sort -u)" ]; then
    echo "Couldn't stop $app_name. Close its window instead."
    return 1
  fi
  echo "$app_name stopped."
}

# Gets the newest version. A copy installed from the install branch gets the newest build, which
# replaces the old one (the history, settings and .env stay); a copy of the source code gets the
# newest code (git pull). A running app is stopped first and started again afterwards, installing
# any new packages as it starts.
update_app() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git isn't installed. Install it (macOS: xcode-select --install; Debian or Ubuntu: sudo apt install git), then update again."
    return 1
  fi
  if [ ! -d .git ]; then
    echo "This copy of $app_name wasn't installed with Git, so it can't update itself."
    echo "Install it again with git clone, as its README.md says."
    return 1
  fi
  was_running=false
  if [ -n "$(server_pids | sort -u)" ]; then
    was_running=true
    stop_app || return 1
  fi
  branch="$(git rev-parse --abbrev-ref HEAD)"
  before="$(git rev-parse HEAD)"
  if [ "$branch" = install ]; then
    echo "Getting the newest build..."
    # Each build replaces the one before on the install branch (it keeps no history), so switch
    # to the new one rather than merging it.
    git fetch --depth 1 origin install && git reset --hard --quiet FETCH_HEAD
  else
    echo "Getting the newest code ($branch)..."
    git pull --ff-only
  fi || {
    echo "Couldn't update (see above). Check the internet connection, and that Git is signed in to GitHub."
    return 1
  }
  if [ "$(git rev-parse HEAD)" = "$before" ]; then
    echo "$app_name is up to date."
  else
    echo "Updated $app_name: $(git log -1 --format=%s)"
  fi
  if $was_running; then
    log="${TMPDIR:-/tmp}/youtube-audio-extractor.log"
    echo "Starting it again in the background (its output goes to $log)..."
    nohup sh "$here/app.sh" start --no-browser >"$log" 2>&1 &
  fi
}

update_ytdlp() {
  exe=node_modules/youtube-dl-exec/bin/yt-dlp
  if [ ! -x "$exe" ]; then
    echo "yt-dlp isn't installed yet - installing it..."
    npm rebuild youtube-dl-exec || true
    if [ ! -x "$exe" ]; then
      echo "Couldn't install yt-dlp (see above)."
      return 1
    fi
  fi
  before="$("$exe" --version)"
  echo "yt-dlp $before - looking for a newer version..."
  failed=false
  "$exe" -U || failed=true
  after="$("$exe" --version)"
  if [ "$after" != "$before" ]; then
    echo "Updated yt-dlp from $before to $after."
  elif $failed; then
    echo "Couldn't update yt-dlp (see above). Check the internet connection and try again."
    return 1
  else
    echo "yt-dlp $after is already the newest version."
  fi
}

action="${1:-start}"
[ $# -gt 0 ] && shift
case "$action" in
  start) start_app "$@" ;;
  stop) stop_app ;;
  update) update_app ;;
  update-yt-dlp) update_ytdlp ;;
  *)
    echo "Usage: app.sh start [--no-browser] [--dev] | stop | update | update-yt-dlp"
    exit 2
    ;;
esac
