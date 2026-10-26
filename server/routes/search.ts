/** Finding a song: video info, search, YouTube playlists, and how the sources have been answering. */
import type { Express } from "express";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId } from "../youtube-url";
import { SearchFailed, searchSongs, searchSoundCloudOnly, type SongSearchOptions } from "../search";
import {
  SpotifyError,
  fetchSpotifyTrack,
  readSpotifyLink,
  spotifyLinkError,
  spotifySearchQuery,
} from "../spotify";
import { fetchVideoInfo, ytDlpFailure } from "../audio";
import { YouTubePlaylistError, fetchYouTubePlaylist } from "../youtube-playlist";
import { YouTubeRefused, sendRefused, videoCacheKey, youtubeGuard } from "../youtube-limits";
import { sourceHealth } from "../source-health";
import { validationError } from "./helpers";

export function registerSearchRoutes(app: Express) {
  // How YouTube, SoundCloud and Spotify have been answering lately (see source-health.ts).
  // Nothing in it is about this computer: no paths, no secrets.
  app.get(api.health.sources.path, (_req, res) => {
    res.set("Cache-Control", "no-store").json(sourceHealth.report());
  });

  // The yt-dlp calls below go through youtubeGuard (youtube-limits.ts): a
  // recent answer comes from its cache, and when YouTube refuses (it's
  // limiting this computer) the answer is a 502 that says so, straight away.
  app.post(api.video.info.path, async (req, res) => {
    try {
      const input = api.video.info.input.parse(req.body);

      const videoId = extractVideoId(input.url);
      if (!videoId) {
        return res.status(400).json({ message: "Invalid YouTube URL" });
      }

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      const video = await youtubeGuard.run({
        key: videoCacheKey(videoId),
        attempt: (signIn) => fetchVideoInfo(canonical, signIn),
      });

      res.status(200).json({ ...video, url: input.url });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.issues[0].message,
          field: err.issues[0].path.join("."),
        });
      }
      if (err instanceof YouTubeRefused) return sendRefused(res);
      res.status(500).json({ message: ytDlpFailure(err) });
    }
  });

  // Song search: top results for a text query, official uploads first. A
  // Spotify song link searches for that song, preferring same-length uploads.
  // YouTube's results, or SoundCloud's when YouTube's search fails or finds
  // nothing — SoundCloud is asked at the same time while YouTube has been
  // refusing this computer (searchSongs()). `source=soundcloud` asks
  // SoundCloud alone: for a song YouTube refused to hand over.
  app.get(api.video.search.path, async (req, res) => {
    const query = api.video.search.query.safeParse(req.query);
    if (!query.success) {
      const [issue] = query.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") || "q" });
    }
    const { q, source } = query.data;
    const search = (text: string, options: SongSearchOptions = {}) =>
      source === "soundcloud"
        ? searchSoundCloudOnly(options.soundCloudQuery ?? text, options)
        : searchSongs(text, options);
    try {
      const spotifyLink = await readSpotifyLink(q);
      if (!spotifyLink) return res.json(await search(q));
      if (spotifyLink.kind !== "track") {
        return res.status(400).json({ message: spotifyLinkError(spotifyLink), field: "q" });
      }
      const spotify = await fetchSpotifyTrack(spotifyLink.id);
      const answer = await search(spotifySearchQuery(spotify), {
        targetDuration: spotify.duration,
        soundCloudQuery: spotifySearchQuery(spotify, "soundcloud"),
      });
      res.json({ ...answer, spotify });
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      if (err instanceof SearchFailed) {
        return res
          .status(err.status)
          .json(
            err.limited
              ? { message: err.message, source: "youtube", limited: true }
              : { message: err.message },
          );
      }
      console.error("Search failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Search failed" });
    }
  });

  // The videos in a public YouTube playlist, for the playlist panel. Picking
  // one opens it like a pasted link; "Download" saves the ticked ones as they are.
  app.get(api.youtube.playlist.path, async (req, res) => {
    const query = api.youtube.playlist.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      res.json(await fetchYouTubePlaylist(query.data.link));
    } catch (err) {
      if (err instanceof YouTubePlaylistError) {
        return res.status(err.status).json({ message: err.message });
      }
      if (err instanceof YouTubeRefused) return sendRefused(res);
      console.error("Reading the YouTube playlist failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't read it" });
    }
  });
}
