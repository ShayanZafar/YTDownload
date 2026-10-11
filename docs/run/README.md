# Running the app

How to install, start and stop the YouTube Audio Extractor, start it with Windows, use it from your phone, and keep it working. The scripts are in [`scripts/windows/`](../../scripts/windows/) and, for macOS and Linux, [`scripts/unix/`](../../scripts/unix/).

## Quick start (Windows)

A PC can have the app two ways:

- **The ready-to-run app**, for using it: the built app, from the repository's `install` branch, which GitHub builds after every change. No source code and nothing to build — install it once, and update it with a double-click.
- **The source code**, for changing it: this `main` branch, run with the development server.

### Installing the ready-to-run app

1. **Install Node.js and Git, once.** In PowerShell: `winget install -e --id OpenJS.NodeJS.LTS`, then `winget install -e --id Git.Git`. Then close and reopen PowerShell.
2. **Get the app.** This puts it in a folder called "YouTube Audio Extractor" in your user folder; the repository is private, so sign in to GitHub if Git asks.

   ```powershell
   git clone --depth 1 --branch install https://github.com/ShayanZafar/YTDownload.git "$HOME\YouTube Audio Extractor"
   ```

3. **Double-click `Start.cmd`** in that folder. The first time, it installs what the app needs (yt-dlp and ffmpeg among them), which takes a minute or two; after that the app starts in a few seconds. It opens in your browser at http://localhost:5000. Keep its window open while you use the app.
4. **To update it, double-click `Update.cmd`.** It gets the newest build; your download history, settings and `.env` stay. If the app is running, it's stopped and started again.

`Start.cmd`, `Stop.cmd` and `Update.cmd` at the top of the folder run the scripts in `scripts\windows\` (below), which are all there too.

### Running it from the source code

1. **Install Node.js, once.** In PowerShell: `winget install -e --id OpenJS.NodeJS.LTS`. Then close and reopen any open terminal windows.
2. **Double-click `scripts\windows\start.cmd`.** The first time, it installs what the app needs, which takes a minute or two; after that the app starts in a few seconds. It opens in your browser at http://localhost:5000.
3. **Keep the window open while you use the app.** Closing it stops the app, and so does running `stop.cmd`.

Double-clicking `start.cmd` while the app is already running just opens the page again. For a desktop shortcut, right-click `start.cmd` (or `Start.cmd`), then **Send to** → **Desktop (create shortcut)** (on Windows 11, **Send to** is under **Show more options**).

## Quick start (macOS and Linux)

The same two ways, with the scripts in `scripts/unix/`. You need Node.js (the LTS version from [nodejs.org](https://nodejs.org), or `brew install node` on macOS, `sudo apt install nodejs npm` on Debian and Ubuntu) and Git.

- **The ready-to-run app**: `git clone --depth 1 --branch install https://github.com/ShayanZafar/YTDownload.git "$HOME/YouTube Audio Extractor"`, then double-click `Start.command` in that folder on macOS, or run `./Start.sh` in it on Linux. `Stop` and `Update` work the same way.
- **The source code**: double-click `scripts/unix/start.command` (macOS) or run `scripts/unix/start.sh` (Linux). The first time, it installs what the app needs, which takes a minute or two; then the app starts and opens at http://localhost:5000. Keep the window open while you use the app; Ctrl+C, or `scripts/unix/stop.sh`, stops it.

Some Linux file managers open a double-clicked `.sh` file as text; run it from a terminal, or use the file manager's "Run" choice. There is no autostart script for macOS and Linux: `start.sh --no-browser` in a login item or a user service does the same as `autostart-on.cmd`.

## The scripts

| Script              | What it does                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start.cmd`         | Starts the app and opens it in your browser, or just opens the page if it's running already. First it installs what the app needs, when that's needed: the first time, and after an update changes the packages. `start.cmd -NoBrowser` starts it without opening the browser. |
| `stop.cmd`          | Stops the app, however it was started: by `start.cmd`, with Windows, or with `npm run dev` in a terminal.                                                                                                                                                                      |
| `update.cmd`        | Gets the newest version: the newest build in the ready-to-run app, the newest code (`git pull`) in a copy of the source code. A running app is stopped first and started again afterwards, and the next start installs any new packages.                                       |
| `update-yt-dlp.cmd` | Updates yt-dlp, the part of the app that talks to YouTube. Run it when downloads start failing — YouTube changes things every few weeks — preferably while nothing is downloading.                                                                                             |
| `autostart-on.cmd`  | Starts the app whenever you sign in to Windows (minimized, without opening the browser), so it's always there at http://localhost:5000.                                                                                                                                        |
| `autostart-off.cmd` | Stops starting it with Windows.                                                                                                                                                                                                                                                |

They're `.cmd` files so a double-click runs them whatever PowerShell's script setting is; the work is done by `app.ps1` next to them. `scripts/unix/` has `start.sh`, `stop.sh`, `update.sh` and `update-yt-dlp.sh` for macOS and Linux, plus `start.command`, `stop.command` and `update.command` for a double-click in Finder; they do the same through `app.sh`. They take the app's settings (like `PORT`) from its `.env` file, as the app does. In the ready-to-run app, `start.cmd` runs the built app; in a copy of the source code, the development server.

## Starting it with Windows

`autostart-on.cmd` puts a shortcut to `start.cmd -NoBrowser` in your Startup folder (type `shell:startup` in File Explorer's address bar to see it), set to open minimized. The app's window then sits on the taskbar; close it, or run `stop.cmd`, to stop the app until you next sign in. `autostart-off.cmd` removes the shortcut.

## Running it from a terminal

The scripts run these commands for you on Windows. On macOS and Linux — where `scripts/unix/` has the same scripts, or — type them yourself, with `npm` instead of `npm.cmd`.

```powershell
cd C:\Code\YTDownload
npm.cmd run dev              # http://localhost:5000 — Ctrl+C stops it
```

- The first time, and after an update that changes the packages, install them first:
  `$env:YOUTUBE_DL_SKIP_PYTHON_CHECK="1"; npm.cmd install` (on macOS and Linux: `YOUTUBE_DL_SKIP_PYTHON_CHECK=1 npm install`). The variable stops yt-dlp's installer from asking for Python, which the app doesn't use: Windows gets the standalone `yt-dlp.exe`, and on macOS and Linux the install puts yt-dlp's standalone build in place.
- In PowerShell, plain `npm` may be blocked by the script setting — that's why these use `npm.cmd`.
- A lighter way to run it every day: `npm.cmd run build` once (and again after each update), then `npm.cmd start`.
- `npm.cmd run update-yt-dlp` gets the newest yt-dlp, like `update-yt-dlp.cmd`.
- After changing `.env`, restart the app (`stop.cmd`, then `start.cmd`).

## Using it from your phone

The app only answers this computer until you tell it otherwise. From another device, songs download to that device, and the music player (**Your music**) plays the songs stored on that device; **Save to**, **In folder**, **Download all** and playing the Save to folder stay on the computer running the app.

- **On the same Wi-Fi:** put `HOST=0.0.0.0` in the `.env` file (copy `.env.example` to `.env` if there isn't one), restart the app, and allow Node.js when Windows Firewall asks. Then open `http://<this PC's IP address>:5000` on the phone; `ipconfig` shows the address.
- **From anywhere:** install [Tailscale](https://tailscale.com) (free for personal use) on this PC and the phone, signed in to the same account, and set `HOST=0.0.0.0` as above. Open `http://<this PC's Tailscale IP>:5000` — the Tailscale app shows the IP. To use the PC's Tailscale name instead of the IP, add it to `ALLOWED_HOSTS` in `.env`. Only your own devices can reach the app, and YouTube sees your home internet connection, so downloads keep working.

Either way, the computer has to be on, with the app running. The phone can't run the app by itself: finding and downloading songs takes yt-dlp and ffmpeg, which run on the computer.

### On the phone's home screen

Once the phone can open the app, put it on the home screen, so it opens from its own icon:

- **iPhone:** in Safari, tap **Share** → **Add to Home Screen**. Turn **Open as Web App** off: an iPhone stops a home-screen web app's music when the phone locks or you switch apps, but Safari keeps playing. (Left on, the app opens in a window of its own, without Safari's address bar.)
- **Android:** in Chrome, tap **⋮** → **Add to Home screen**. Over a plain `http://` address that's a shortcut that opens in Chrome; with an `https://` address (below), Chrome installs it as an app, in a window of its own.

### HTTPS with Tailscale

Tailscale can give the app an `https://` address on your devices, which Android needs to install it as an app:

1. On the PC, with Tailscale running, in PowerShell:

   ```powershell
   tailscale serve --bg --https=443 localhost:5000
   ```

   If it asks you to turn on HTTPS for your tailnet, follow the link it shows. It keeps serving, across restarts, until you turn it off with `tailscale serve --https=443 off`.

2. Put the PC's Tailscale name in `ALLOWED_HOSTS` in `.env` — `ALLOWED_HOSTS=my-pc.tail1234.ts.net`, say (`tailscale serve status` shows it) — and restart the app. `HOST` can stay as it is: Tailscale hands the requests to the app on this PC.
3. On the phone, open `https://<that name>`, and add it to the home screen as above.

The app treats requests through that address as another device's, even from the PC itself — so on the PC, keep using http://localhost:5000 for **Save to** and the folder's songs.

## Keeping it working

- **YouTube downloads fail** ("Sign in to confirm you're not a bot", "HTTP Error 403", or "Video unavailable" for a video that plays fine on YouTube): run `update-yt-dlp.cmd` (on macOS and Linux, `scripts/unix/update-yt-dlp.sh`). The app tries this itself, once an hour at most, when a failure looks like an outdated yt-dlp — the terminal (or the log) says "yt-dlp: … updating yt-dlp" when it does.
- **If YouTube says it's limiting this computer** ("YouTube is limiting this computer. Wait about 10 minutes, then try again."): YouTube has answered "Too Many Requests" or asked for a sign-in to prove you're not a bot. The app leaves YouTube alone for 10 minutes and answers that message straight away meanwhile (**Download all** waits it out by itself, then carries on). Wait, then try again; if it keeps happening, update yt-dlp as above and give YouTube a longer rest. `data/source-health.json` (or `http://localhost:5000/api/health/sources`) says how YouTube and Spotify have been answering over the last day — [docs/sources.md](../sources.md) explains it.
- **New versions of the app:** double-click `Update.cmd` in the ready-to-run app, or `scripts\windows\update.cmd` (`scripts/unix/update.sh` on macOS and Linux) in a copy of the source code (it runs `git pull`). The next start installs any new packages by itself.

## Hosting it somewhere else

It runs on any host that runs Node.js apps (see [Deploying](../../TECHNICAL.md#deploying)), but a free cloud host isn't a good home for it:

- YouTube blocks most data-centre addresses, so downloads from cloud servers tend to fail with "Sign in to confirm you're not a bot". The usual workaround, giving the server your YouTube login cookies, puts your account at risk.
- **Save to**, **In folder** and **Download all** only work in a browser on the computer running the app.
- The app has no login, so anyone with its address could use it — and a public YouTube download site goes against YouTube's terms.

Running it on your own PC and reaching it with Tailscale (above) avoids all three.

## Troubleshooting

| What you see                                 | What to do                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Node.js isn't installed"                    | Install it with `winget install -e --id OpenJS.NodeJS.LTS`, then start the app again.                                                                                                                            |
| "Port 5000 is being used by another program" | Close that program, or put `PORT=5001` in `.env` — the scripts follow it.                                                                                                                                        |
| "Installing failed"                          | Check the internet connection and start again. If the message says `ENAMETOOLONG`, turn on Windows long paths ([Common Windows gotchas](../../TECHNICAL.md#common-windows-gotchas)).                             |
| The phone can't open the page                | Check `.env` has `HOST=0.0.0.0` and the app was restarted, and that Windows Firewall allows Node.js (Windows Security → Firewall & network protection → Allow an app through firewall).                          |
| Downloads fail with a YouTube error          | Run `update-yt-dlp.cmd`.                                                                                                                                                                                         |
| "YouTube is limiting this computer"          | Wait about 10 minutes — the app does, too (**Download all** carries on by itself). If it keeps happening, run `update-yt-dlp.cmd` and give YouTube a longer rest. See [Keeping it working](#keeping-it-working). |
| "Couldn't update"                            | Check the internet connection and update again. If Git asks you to sign in, use the GitHub account the repository belongs to.                                                                                    |
| "Git isn't installed"                        | Install it with `winget install -e --id Git.Git`, then update again.                                                                                                                                             |
