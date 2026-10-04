# YouTube Audio Extractor — ready to run

This branch is the app, built and ready to run: no source code, nothing to build. GitHub Actions makes it from the `main` branch after every change ([`install.yml`](https://github.com/{{REPO}}/blob/main/.github/workflows/install.yml)), and each build replaces the one before — so don't change it by hand.

This build: [`{{SHORT_SHA}}`](https://github.com/{{REPO}}/commit/{{SHA}}), {{DATE}} — {{SUBJECT}}

## Install it on a Windows PC

1. **Install Node.js and Git, once.** In PowerShell:

   ```powershell
   winget install -e --id OpenJS.NodeJS.LTS
   winget install -e --id Git.Git
   ```

   Then close and reopen PowerShell.

2. **Get the app** — into a folder called "YouTube Audio Extractor" in your user folder, say. The repository is private, so sign in to GitHub if Git asks.

   ```powershell
   git clone --depth 1 --branch install https://github.com/{{REPO}}.git "$HOME\YouTube Audio Extractor"
   ```

3. **Double-click `Start.cmd`** in that folder. The first start installs what the app needs, yt-dlp and ffmpeg among them, which takes a minute or two; after that it starts in a few seconds. It opens in your browser at http://localhost:5000. Keep its window open while you use the app.

## Using it

| File                         | What it does                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Start.cmd`                  | Starts the app and opens it in your browser (or just opens the page, if it's running).                                                  |
| `Stop.cmd`                   | Stops the app.                                                                                                                          |
| `Update.cmd`                 | Gets the newest build. Your download history, settings and `.env` stay; a running app is stopped and started again.                     |
| `scripts\windows\`           | The rest: `update-yt-dlp.cmd` when YouTube downloads stop working, `autostart-on.cmd` and `autostart-off.cmd` to start it with Windows. |
| `.env` (copy `.env.example`) | Settings, like the port, or `HOST=0.0.0.0` to let your phone use the app.                                                               |

Your phone uses the app running on this PC — see [Using it from your phone](https://github.com/{{REPO}}/blob/main/docs/run/README.md#using-it-from-your-phone).

On macOS or Linux (no Python needed): install with `YOUTUBE_DL_SKIP_PYTHON_CHECK=1 npm ci --omit=dev`, start with `npm start`, and update with `git fetch --depth 1 origin install && git reset --hard FETCH_HEAD` (then install again). `npm run update-yt-dlp` gets the newest yt-dlp.

More: [Running the app](https://github.com/{{REPO}}/blob/main/docs/run/README.md) and the [user guide](https://github.com/{{REPO}}/blob/main/README.md).
