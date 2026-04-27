# YouTube Audio Extractor

A clean, fast web app for converting YouTube videos into high-quality MP3 audio files. Paste any YouTube link, preview the video, and download the audio in one click.

## What It Does

- **Paste a YouTube URL** — Drop in any standard YouTube video link.
- **Preview the video** — See the title and thumbnail before downloading, so you can confirm you've got the right one.
- **Extract high-quality audio** — One-click download of the audio track in MP3 format at the highest available quality.
- **Browse recent extractions** — Every download is saved to a history list so you can quickly grab a file again later without re-pasting the URL.

## Key Features

| Feature               | Description                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Instant video preview | Title and thumbnail load before you commit to downloading.                                         |
| High-quality audio    | Pulls the best available audio stream from the source video.                                       |
| MP3 download          | Files are delivered as `.mp3` with a sensible filename derived from the video title.               |
| Download history      | A persistent list of recent extractions with one-click redownload.                                 |
| Friendly errors       | Clear messages when a URL is invalid, the video can't be fetched, or the network fails.            |
| Responsive design     | Works on desktop and mobile, with a polished hero section, animated result card, and history grid. |

## How To Use It

1. Open the app in your browser.
2. Paste a YouTube URL into the input box (for example, `https://www.youtube.com/watch?v=...`).
3. Click **Extract** — a preview card appears with the video's title and thumbnail.
4. Click **Download Audio** to save the MP3 to your device.
5. Scroll down to **Recent Extractions** to redownload any audio file you've previously fetched.

## Notes & Limitations

- The app extracts audio only — video downloads are not supported.
- The source video must be publicly accessible on YouTube (age-restricted, private, or members-only videos may fail).
- Downloaded files are intended for personal use. Please respect YouTube's Terms of Service and the rights of content creators.

## Looking For Setup Or Deployment Info?

See [TECHNICAL.md](./TECHNICAL.md) for architecture details, local development setup, environment variables, and deployment instructions.
