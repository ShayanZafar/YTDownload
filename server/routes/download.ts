/** Downloading a song's audio to the browser. */
import type { Express } from "express";
import { storage } from "../storage";
import { api } from "@shared/routes";
import { audioLinkOf } from "@shared/soundcloud-link";
import { safeFileName } from "@shared/filename";
import { fileNameOf, songOfVideo } from "@shared/song-name";
import { spotifySongTags } from "../spotify";
import { prepareAudioOutput, startAudioPipeline, type PreparedOutput } from "../audio";
import { audioEnded, lookUpAudio, sourceName } from "../audio-source";
import { coverFor } from "../cover";
import { lateDetails, lookUpDownload } from "../download-details";
import { downloadEntry, logDetails } from "../details-log";
import { YouTubeRefused, sendRefused } from "../youtube-limits";

export function registerDownloadRoutes(app: Express) {
  // Streams a video's audio as a download: yt-dlp → ffmpeg → response. `url`
  // is a YouTube video, or a SoundCloud track (a SoundCloud search result).
  // `?format=mp3` (default) converts to MP3; `?format=original` keeps the
  // source's own stream untouched. See server/audio.ts for the details.
  app.get(api.video.download.path, async (req, res) => {
    // Watch for the browser going away (download cancelled, tab closed) from the
    // very start — the metadata lookup below can take 10–20s, and a cancel during
    // it must stop us from starting processes that would then block forever.
    let clientGone = false;
    let stopPipeline: (() => void) | undefined;
    // The cover files made for this download, deleted once it's over.
    let output: PreparedOutput | undefined;
    res.on("close", () => {
      if (res.writableFinished) return; // normal completion
      clientGone = true;
      stopPipeline?.();
    });

    try {
      const query = api.video.download.query.safeParse(req.query);
      if (!query.success) {
        return res.status(400).send(query.error.issues[0].message);
      }
      const { url, format, name, spotifyId } = query.data;
      // Only a YouTube video or a SoundCloud track, and only its canonical link
      // goes to yt-dlp.
      const link = audioLinkOf(url);
      if (!link) {
        return res.status(400).send("Invalid or missing YouTube or SoundCloud link");
      }

      // A Spotify song is tagged with Spotify's title and artists (looked up
      // while the source is asked about the audio).
      const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;
      // And its cover: Spotify's album cover, or the video's thumbnail — looked up
      // meanwhile — or a SoundCloud track's artwork, once the look-up has found it.
      const videoCover =
        link.source === "youtube"
          ? coverFor({ kind: "youtube", videoId: link.videoId }, songTags)
          : undefined;

      // Metadata first, so audio that can't be downloaded fails with a clean
      // error before a streaming response is opened. (A refusal from YouTube
      // is answered at once with a 502 that says so.)
      const info = await lookUpAudio(link);
      // Its artist and title as a player shows them — the artist the video's title names, not
      // the channel that uploaded it, without "(Official Video)", "HQ"… — unless Spotify names it.
      const song = songOfVideo(info.title, info.artist);
      const tags = {
        ...info,
        title: song.title,
        artist: song.artist ?? undefined,
        ...(await songTags),
        spotifyId,
      };
      // Its genre (and for a song without an album, its album) from the music
      // catalogues, looked up meanwhile. It never fails or holds the download up.
      const lookedUp = lookUpDownload(tags, info.duration);

      // Cancelled while we were looking up the video: don't start any work.
      if (clientGone) return;

      // These only go out with the first chunk of audio, so a failure before
      // then can still be turned into a proper error response (see below).
      const cover =
        videoCover ??
        coverFor(info.artwork ? { kind: "soundcloud", url: info.artwork } : undefined, songTags);
      const ownCover = await cover;
      const later = lateDetails(lookedUp, ownCover !== undefined);
      // What it got, or why not, goes in the details log.
      void later.then((found) => logDetails(downloadEntry(name || info.title, found)));
      output = await prepareAudioOutput(format, tags, info.acodec, ownCover, later);
      if (clientGone) return;
      // Saved as the name chosen on the page, or "Artist - Title" (fileNameOf: made
      // safe too). res.attachment writes both a plain filename and a UTF-8 one
      // (filename*), so accents and non-Latin titles survive.
      const fileName = `${name ? safeFileName(name) : fileNameOf(song)}.${output.ext}`;
      res.attachment(fileName);
      res.header("Content-Type", output.contentType);

      // yt-dlp is pinned to the stream the metadata pass picked, so the container
      // chosen for "original" always matches the audio that arrives.
      const pipeline = startAudioPipeline(
        link.url,
        info.formatId,
        output.ffmpegArgs,
        output.prefix,
      );
      stopPipeline = pipeline.stop;
      pipeline.audio.pipe(res, { end: false });

      const { ok, reason } = await pipeline.finished;
      if (clientGone) return;
      // Recorded for the source-health report; YouTube may have refused it.
      const refused = audioEnded(link, ok, reason);

      if (!res.headersSent) {
        // Failed before producing any audio (e.g. YouTube refused the stream).
        res.removeHeader("Content-Disposition");
        if (refused) {
          console.error(`Download refused by YouTube before any audio was sent: ${reason}`);
          return sendRefused(res);
        }
        const why = reason || `${sourceName(link)} sent no audio`;
        console.error(`Download failed before any audio was sent: ${why}`);
        return res.status(502).type("text/plain").send(`Couldn't download the audio: ${why}`);
      }

      // Audio was already flowing. On a mid-stream failure the file is cut
      // short — there's no way to signal an error once a 200 has been sent.
      if (!ok) console.error(`Download cut short: ${reason}`);

      // Download history: only record a download that fully succeeded — both
      // processes exited cleanly and the whole file was handed to the browser.
      // A cancel or a failure part-way through leaves no entry.
      res.once("finish", () => {
        if (!ok || clientGone) return;
        storage
          .createDownload({ url, title: info.title, spotifyId, source: link.source, fileName })
          .catch((err) => console.error("Failed to save download history", err));
      });
      res.end();
    } catch (err) {
      stopPipeline?.();
      if (err instanceof YouTubeRefused && !res.headersSent) {
        res.removeHeader("Content-Disposition");
        return sendRefused(res);
      }
      console.error(err);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res
          .status(500)
          .type("text/plain")
          .send(err instanceof Error ? err.message : "Failed to download video");
      } else {
        res.end();
      }
    } finally {
      // ffmpeg has read the cover by now (or never will): it's no longer needed.
      void output?.cleanup();
    }
  });
}
