# YouTube Audio Extractor

A clean, fast web app for converting YouTube videos into high-quality MP3 audio files. Paste any YouTube link — or search for a song by name — preview it, and download the audio in one click.

## What It Does

- **Paste a YouTube URL** — Drop in any standard YouTube video link.
- **Or search for a song** — Type an artist and song title to find it on YouTube. Uploads from the artist or their label come first, marked **Official**.
- **Or paste a Spotify song link** — The app reads the song's name, artist and length from Spotify and finds the same recording on YouTube. (Spotify's own audio can't be downloaded; the audio comes from YouTube.)
- **Or open a Spotify playlist** — Paste a public playlist's (or album's) link and pick songs from it to find on YouTube and download. With a **Save to** folder, it shows which songs are already in that folder and downloads the rest for you in one go.
- **Preview the video** — See the title and thumbnail before downloading, so you can confirm you've got the right one.
- **Extract high-quality audio** — One-click download of the audio track as a 320 kbps MP3 (the highest MP3 quality), converted from the best audio stream YouTube offers for free.
- **Browse recent extractions** — Every completed download is saved to a history list so you can quickly grab a file again later without re-pasting the URL. Cancelled or failed downloads aren't added. Search it to find a song you extracted a while ago.

## Key Features

| Feature               | Description                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Instant video preview | Title and thumbnail load before you commit to downloading.                                                                              |
| Song search           | Search YouTube by artist and title; official uploads first, live/cover/remix versions last unless you ask.                              |
| Spotify song links    | Paste a Spotify song link to get the same recording from YouTube, matched by artist, title and length.                                  |
| Spotify playlists     | Paste a playlist or album link to list its songs; see which are already in your folder and download the rest in one go. No account.     |
| High-quality audio    | Pulls the best available audio stream from the source video.                                                                            |
| MP3 download          | Real MP3 files (320 kbps) named after the video, with title and artist tags that music players show.                                    |
| Original audio option | A toggle to get YouTube's own audio stream instead — not converted, smaller (usually `.opus`). Great in VLC.                            |
| Save to a folder      | Pick a folder once in the app's folder browser and downloads go straight into it instead of the browser's downloads folder.             |
| Any browser           | Every feature works in Chrome, Edge, Firefox and Safari.                                                                                |
| Download history      | A persistent list of your last 1,000 extractions with one-click redownload — searchable, with suggestions as you type and date filters. |
| Friendly errors       | Clear messages when a URL is invalid, the video can't be fetched, or the network fails.                                                 |
| Responsive design     | Works on desktop and mobile, with a polished hero section, animated result card, and history grid.                                      |

## How To Use It

1. Start the app: on Windows, double-click `scripts\windows\start.cmd`, and it opens in your browser at http://localhost:5000. [Running the app](docs/run/README.md) covers the other scripts (stop, update, start with Windows) and using it from your phone.
2. Either paste a YouTube URL into the input box (for example, `https://www.youtube.com/watch?v=...`) and click **Extract**, or switch to **Search by song**, type the artist and song title, click **Search**, and pick a result. Either way, a preview card appears with the video's title and thumbnail. (The app remembers which one you used last, and it works out what you meant: a link typed into the search box is opened, and plain words typed into the link box are searched for.) You can also paste a Spotify song link (in Spotify: **Share → Copy Song Link**) into either box — the best YouTube match is picked for you, and uploads the same length as the Spotify song are marked **Same length**.
   - Working through a Spotify playlist? Switch to **Spotify playlist**, paste the playlist's link (in Spotify: **Share → Copy link to playlist**; album links work too) and click **Open**. A panel lists its songs — type in **Filter songs** to find one — and clicking a song looks for it on YouTube, just like pasting that song's link: the best match is picked, ready to download, named "Artist - Title". The panel stays open on your next visit until you close it (**×**); the reload button fetches the playlist again if you've changed it in Spotify.
   - With a **Save to** folder chosen (step 5), the panel checks that folder — subfolders too, like Artist\Album — and marks each song **In folder** or not, going by the files' names and their title and artist tags. **Not in folder** shows just the missing songs. Each has a tick box, all ticked to begin with: untick any you don't want, then click **Download N songs**. The app finds and saves them one after another, with each song's progress in the list. It only downloads a song when the best YouTube match is the same length as the song on Spotify — so almost surely the same recording; any other song is marked **Check** for you to click and pick yourself. **Stop** cancels the song being saved (nothing half-saved is left behind); pressing **Download** again carries on with what's left. Without a folder, songs you've downloaded from the panel show **Downloaded** instead.
3. Not the right video? Pick a different search result, or click **Clear and start over**. Done with the search results? **Close** them — the video you picked stays ready to download.
4. Want a different file name? Click the title in the preview card (it's underlined, with **Rename file** under it) and type a new name, like you would in a Save As dialog; Enter keeps it, Esc cancels, and **Use the original title** undoes it. Characters Windows doesn't allow in file names are swapped out (e.g. "AC/DC: Live" becomes "AC-DC - Live"); accents and other languages are kept.
5. Click **Download Audio** to save the MP3 to your device. Prefer the untouched original? Turn on **Original audio** first — the app remembers your choice, and it also applies to redownloads.
   - Want the files somewhere other than your browser's downloads folder? Just below the search box, next to **Save to**, click **Choose folder** — you can do this before opening a video. The app's folder browser opens (in your Music folder): click a folder to open it, use the shortcuts along the top (Music, Downloads, Desktop, Documents, your drives), paste a path (Explorer's **Copy as path** works), or make a **New folder**. Then click **Use “…”**. From then on, downloads go straight into that folder, with progress and a **Cancel** button on the page. The app remembers the folder, for whichever browser you use. Click the **×** next to the folder name to go back to your browser's downloads folder. A file that already exists is never overwritten — the new one is saved as "Song (1).mp3".
6. Scroll down to **Recent Extractions** to redownload any audio file you've previously fetched. The app keeps your last 1,000 downloads, 25 at a time (**Show more** for the rest). To find an older one:
   - Type in **Search your extractions**. The list narrows as you type — every word must match, in any order, and partial words count ("prog ocea" finds "Progression - Ocean Green"). Pasting a YouTube link finds past downloads of that video.
   - Matching songs are suggested below the box, each listed once (with "2×" if you downloaded it more than once). Pick one — click it, or use the arrow keys and Enter — to show exactly that song; **Show everything** undoes it.
   - Use **All**, **Past week**, **Past month** or **Older** (more than 30 days ago) to narrow by date. These combine with the search.

## Notes & Limitations

- The app extracts audio only — video downloads are not supported.
- **Save to** works in any browser on the computer running the app — the app saves the file itself. On another device (say, your phone using the app over Wi-Fi), downloads go to that device's downloads folder, and the app says so instead of showing the setting. Windows keeps a few folders for administrators (like the top of `C:\` or Program Files); the app tells you if you pick one — choose a folder inside your user folder instead, like Music.
- Leaving or reloading the page while a download is being saved into your folder cancels it, so the browser asks first.
- Spotify: song links work in the link or search box, and playlist or album links in **Spotify playlist** — not artists or podcasts, and not `spotify.link` short links (open one and copy the `open.spotify.com` address instead). No Spotify account is needed, so only public playlists can be opened (in Spotify, a playlist's **…** menu has **Make public**), and Spotify shares only the first 100 songs of a playlist this way; for a later song, paste its own link. Liked Songs isn't a playlist Spotify shares.
- Songs downloaded for a Spotify song are named "Artist - Title" and tagged with Spotify's title and artists and the song's Spotify id — so the playlist panel recognises them in your folder even if you rename them. For other files, it goes by their names and tags, so a file called just "Track 01.mp3" with no tags can't be recognised. It looks at up to 5,000 songs in a folder (and six folders deep).
- Every YouTube upload of a song has the same audio quality ceiling for free (about 130 kbps Opus), so for music, the artist's or label's own upload — the ones marked **Official** — is usually the cleanest source.
- The source video must be publicly accessible on YouTube (age-restricted, private, or members-only videos may fail).
- Downloaded files are intended for personal use. Please respect YouTube's Terms of Service and the rights of content creators.

## Looking For Setup Or Deployment Info?

To start the app, run it with Windows, use it from your phone or host it elsewhere, see [Running the app](docs/run/README.md). For architecture details, local development setup, environment variables, and deployment instructions, see [TECHNICAL.md](./TECHNICAL.md).

## Coming From A Different Stack?

If your background is .NET / C# (or any other stack) and you want a guided tour of this codebase's tech choices and patterns, see [LEARNING.md](./LEARNING.md). It maps every concept here onto its closest .NET equivalent and explains the "why" behind each decision.
