# Running the app

How to start and stop the YouTube Audio Extractor, start it with Windows, use it from your phone, and keep it working. The scripts are in [`scripts/windows/`](../../scripts/windows/).

## Quick start (Windows)

1. **Install Node.js, once.** In PowerShell: `winget install -e --id OpenJS.NodeJS.LTS`. Then close and reopen any open terminal windows.
2. **Double-click `scripts\windows\start.cmd`.** The first time, it installs what the app needs, which takes a minute or two; after that the app starts in a few seconds. It opens in your browser at http://localhost:5000.
3. **Keep the window open while you use the app.** Closing it stops the app, and so does running `stop.cmd`.

Double-clicking `start.cmd` while the app is already running just opens the page again. For a desktop shortcut, right-click `start.cmd`, then **Send to** → **Desktop (create shortcut)** (on Windows 11, **Send to** is under **Show more options**).

## The scripts

| Script              | What it does                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start.cmd`         | Starts the app and opens it in your browser, or just opens the page if it's running already. First it installs what the app needs, when that's needed: the first time, and after an update changes the packages. `start.cmd -NoBrowser` starts it without opening the browser. |
| `stop.cmd`          | Stops the app, however it was started: by `start.cmd`, with Windows, or with `npm run dev` in a terminal.                                                                                                                                                                      |
| `update-yt-dlp.cmd` | Updates yt-dlp, the part of the app that talks to YouTube. Run it when downloads start failing — YouTube changes things every few weeks — preferably while nothing is downloading.                                                                                             |
| `autostart-on.cmd`  | Starts the app whenever you sign in to Windows (minimized, without opening the browser), so it's always there at http://localhost:5000.                                                                                                                                        |
| `autostart-off.cmd` | Stops starting it with Windows.                                                                                                                                                                                                                                                |

They're `.cmd` files so a double-click runs them whatever PowerShell's script setting is; the work is done by `app.ps1` next to them. They take the app's settings (like `PORT`) from its `.env` file, as the app does.

## Starting it with Windows

`autostart-on.cmd` puts a shortcut to `start.cmd -NoBrowser` in your Startup folder (type `shell:startup` in File Explorer's address bar to see it), set to open minimized. The app's window then sits on the taskbar; close it, or run `stop.cmd`, to stop the app until you next sign in. `autostart-off.cmd` removes the shortcut.

## Running it from a terminal

The scripts run these commands for you. They work on macOS and Linux too, with `npm` instead of `npm.cmd`.

```powershell
cd C:\Code\YTDownload
npm.cmd run dev              # http://localhost:5000 — Ctrl+C stops it
```

- The first time, and after an update that changes the packages, install them first:
  `$env:YOUTUBE_DL_SKIP_PYTHON_CHECK="1"; npm.cmd install`. The variable stops yt-dlp's installer from asking for Python, which the Windows yt-dlp doesn't use.
- In PowerShell, plain `npm` may be blocked by the script setting — that's why these use `npm.cmd`.
- A lighter way to run it every day: `npm.cmd run build` once (and again after each update), then `npm.cmd start`.
- After changing `.env`, restart the app (`stop.cmd`, then `start.cmd`).

## Using it from your phone

The app only answers this computer until you tell it otherwise. From another device, songs download to that device, and the music player (**Your music**) plays the songs stored on that device; **Save to**, **In folder**, **Download all** and playing the Save to folder stay on the computer running the app.

- **On the same Wi-Fi:** put `HOST=0.0.0.0` in the `.env` file (copy `.env.example` to `.env` if there isn't one), restart the app, and allow Node.js when Windows Firewall asks. Then open `http://<this PC's IP address>:5000` on the phone; `ipconfig` shows the address.
- **From anywhere:** install [Tailscale](https://tailscale.com) (free for personal use) on this PC and the phone, signed in to the same account, and set `HOST=0.0.0.0` as above. Open `http://<this PC's Tailscale IP>:5000` — the Tailscale app shows the IP. To use the PC's Tailscale name instead of the IP, add it to `ALLOWED_HOSTS` in `.env`. Only your own devices can reach the app, and YouTube sees your home internet connection, so downloads keep working.

Either way, the computer has to be on, with the app running.

## Keeping it working

- **YouTube downloads fail** ("Sign in to confirm you're not a bot", "HTTP Error 403", or "Video unavailable" for a video that plays fine on YouTube): run `update-yt-dlp.cmd`.
- **New versions of the app:** `git pull` in the app's folder, then `start.cmd`, which installs any new packages by itself.

## Hosting it somewhere else

It runs on any host that runs Node.js apps (see [Deploying](../../TECHNICAL.md#deploying)), but a free cloud host isn't a good home for it:

- YouTube blocks most data-centre addresses, so downloads from cloud servers tend to fail with "Sign in to confirm you're not a bot". The usual workaround, giving the server your YouTube login cookies, puts your account at risk.
- **Save to**, **In folder** and **Download all** only work in a browser on the computer running the app.
- The app has no login, so anyone with its address could use it — and a public YouTube download site goes against YouTube's terms.

Running it on your own PC and reaching it with Tailscale (above) avoids all three.

## Troubleshooting

| What you see                                 | What to do                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Node.js isn't installed"                    | Install it with `winget install -e --id OpenJS.NodeJS.LTS`, then start the app again.                                                                                                   |
| "Port 5000 is being used by another program" | Close that program, or put `PORT=5001` in `.env` — the scripts follow it.                                                                                                               |
| "Installing failed"                          | Check the internet connection and start again. If the message says `ENAMETOOLONG`, turn on Windows long paths ([Common Windows gotchas](../../TECHNICAL.md#common-windows-gotchas)).    |
| The phone can't open the page                | Check `.env` has `HOST=0.0.0.0` and the app was restarted, and that Windows Firewall allows Node.js (Windows Security → Firewall & network protection → Allow an app through firewall). |
| Downloads fail with a YouTube error          | Run `update-yt-dlp.cmd`.                                                                                                                                                                |
