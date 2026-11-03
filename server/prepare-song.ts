/**
 * What a download (GET /api/video/download, to the browser) and a save (POST
 * /api/video/save, into the Save to folder) both do before any audio flows:
 * ask the source about the audio; name and tag it — the artist and title the
 * video names, unless Spotify names them — with its cover and, looked up
 * meanwhile, the catalogues' genre and album; note in the details log what
 * they found; and get ffmpeg's arguments and the file's name. One place, so the
 * two can't drift apart.
 */
import { safeFileName } from "@shared/filename";
import type { DownloadFormat } from "@shared/routes";
import { fileNameOf, songOfVideo } from "@shared/song-name";
import type { AudioLink } from "@shared/soundcloud-link";
import { prepareAudioOutput, type AudioInfo, type PreparedOutput } from "./audio";
import { lookUpAudio } from "./audio-source";
import { coverFor } from "./cover";
import type { ArtistSong } from "./artist-genre";
import { downloadEntry, logDetails } from "./details-log";
import { lateDetails, lookUpDownload } from "./download-details";
import { spotifySongTags } from "./spotify";
import { YouTubeRefused } from "./youtube-limits";

/** The source couldn't say what the audio is (not a refusal: that stays `YouTubeRefused`). */
export class AudioLookUpError extends Error {}

export type PreparedSong = {
  /** What the source said about the audio. */
  info: AudioInfo;
  /** ffmpeg's arguments, the MP3 tag that goes in front, and the cover files to delete after. */
  output: PreparedOutput;
  /** "<name chosen on the page>.<ext>", or "Artist - Title.<ext>", made safe. */
  fileName: string;
};

/**
 * Gets a song ready to download or save. Answers undefined if `cancelled()`
 * says the page went away meanwhile (nothing was started). Rejects with
 * `YouTubeRefused`, or `AudioLookUpError` when the source couldn't say.
 */
export async function prepareSong(
  link: AudioLink,
  {
    format,
    name,
    spotifyId,
    folderSongs,
    cancelled,
  }: {
    format: DownloadFormat;
    name?: string;
    spotifyId?: string;
    /** The Save to folder's songs by artist, for a genre the catalogues don't have (a save). */
    folderSongs?: () => Promise<readonly ArtistSong[]>;
    cancelled: () => boolean;
  },
): Promise<PreparedSong | undefined> {
  // A Spotify song is tagged with Spotify's title and artists (looked up
  // while the source is asked about the audio).
  const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;
  // And its cover: Spotify's album cover, or the video's thumbnail — looked up
  // meanwhile — or a SoundCloud track's artwork, once the look-up has found it.
  const videoCover =
    link.source === "youtube"
      ? coverFor({ kind: "youtube", videoId: link.videoId }, songTags)
      : undefined;

  let info: AudioInfo;
  try {
    // A refusal from YouTube is answered at once with a 502 that says so.
    info = await lookUpAudio(link);
  } catch (err) {
    if (err instanceof YouTubeRefused) throw err;
    throw new AudioLookUpError((err as Error).message, { cause: err });
  }
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
  // catalogues, looked up meanwhile — or its artist's genre, from the folder's
  // other songs by them first. It never fails or holds the download up.
  const lookedUp = lookUpDownload(tags, info.duration, { folderSongs });
  // Cancelled while the source was asked: don't start any work.
  if (cancelled()) return undefined;

  const cover =
    videoCover ??
    coverFor(info.artwork ? { kind: "soundcloud", url: info.artwork } : undefined, songTags);
  const ownCover = await cover;
  const later = lateDetails(lookedUp, ownCover !== undefined);
  // What it got, or why not, goes in the details log.
  void later.then((found) => logDetails(downloadEntry(name || info.title, found)));
  const output = await prepareAudioOutput(format, tags, info.acodec, ownCover, later);
  const fileName = `${name ? safeFileName(name) : fileNameOf(song)}.${output.ext}`;
  return { info, output, fileName };
}
