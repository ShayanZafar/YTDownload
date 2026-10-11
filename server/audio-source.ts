/**
 * The two places a download or a save fetches audio from — a YouTube video or
 * a SoundCloud track, told apart by its canonical link (`audioLinkOf()` in
 * shared/soundcloud-link.ts) — as the routes see them: the look-up before the
 * stream starts, and how the stream ended. Both go to the right source's
 * records: YouTube's through `youtubeGuard` (whose refusals the routes answer
 * with `sendRefused()`), SoundCloud's through soundcloud.ts.
 */
import type { AudioLink } from "@shared/soundcloud-link";
import { fetchAudioInfo, type AudioInfo } from "./audio";
import { lookUpSoundCloud, recordSoundCloud } from "./soundcloud";
import { youtubeGuard, type YouTubeRefused } from "./youtube-limits";

/** The source's name, for messages: "YouTube" or "SoundCloud". */
export const sourceName = (link: AudioLink) =>
  link.source === "soundcloud" ? "SoundCloud" : "YouTube";

/**
 * The look-up before a download: title, artist and the stream to pin it to.
 * A YouTube video goes through the guard (a refusal throws `YouTubeRefused`);
 * a SoundCloud track only previewed to non-subscribers is refused here.
 */
export function lookUpAudio(link: AudioLink): Promise<AudioInfo> {
  return link.source === "youtube"
    ? youtubeGuard.run({ attempt: () => fetchAudioInfo(link.url) })
    : lookUpSoundCloud(link.url);
}

/**
 * A stream has ended: recorded for its source. Returns the `YouTubeRefused`
 * to answer with when YouTube refused it.
 */
export function audioEnded(
  link: AudioLink,
  ok: boolean,
  reason: string,
): YouTubeRefused | undefined {
  if (link.source === "youtube") return youtubeGuard.pipelineEnded(ok, reason);
  recordSoundCloud(ok, reason);
  return undefined;
}
