import { api, buildUrl } from "@shared/routes";
import {
  SAME_LENGTH_SECONDS,
  folderFilesSchema,
  saveSettingsSchema,
  songCheckSchema,
  type FolderFile,
  type QualityBar,
  type SaveSettings,
  type SongCheck,
} from "@shared/schema";
import { folderArtistsOf, songKeyOf, tidiedSong } from "@shared/song-name";
import { formatDuration } from "@/lib/format";
import { requestJson } from "@/lib/save-to-folder";

/** Housekeeping's check of one folder song: read all the way through, on the app's computer. */
export function checkFolderSong(id: string, signal?: AbortSignal): Promise<SongCheck> {
  return requestJson(songCheckSchema, buildUrl(api.music.check.path, { id }), { signal });
}

/** The folder's files that aren't songs: pictures, programs, leftovers from downloads. */
export async function fetchOtherFiles(signal?: AbortSignal): Promise<FolderFile[]> {
  return (await requestJson(folderFilesSchema, api.music.otherFiles.path, { signal })).files;
}

/** Saves Housekeeping's quality bar (kept with the app's settings). */
export function saveQualityBar(qualityBar: QualityBar): Promise<SaveSettings> {
  return requestJson(saveSettingsSchema, api.settings.update.path, {
    method: api.settings.update.method,
    json: { qualityBar },
  });
}

/** The quality bars, as the setting offers them. */
export const qualityBarLabels: Record<QualityBar, string> = {
  "128": "Below 128 kbps",
  "192": "Below 192 kbps",
  "256": "Below 256 kbps",
  lossless: "Anything not lossless",
  off: "Don't check",
};

/** What can be wrong with a file, in the order Housekeeping lists them. */
export const problemKinds = [
  "notAudio",
  "cutShort",
  "damaged",
  "lowQuality",
  "copy",
  "other",
] as const;
export type ProblemKind = (typeof problemKinds)[number];

export const problemHeadings: Record<ProblemKind, string> = {
  notAudio: "Not audio",
  cutShort: "Cut short",
  damaged: "Damaged",
  lowQuality: "Low quality",
  copy: "Extra copies",
  other: "Other files",
};

/**
 * What's wrong with a song, from its check and the quality bar — the worst
 * thing only — or null if nothing is. A lossless file always passes a
 * bitrate bar, and one whose bitrate is unknown passes it too.
 */
export function songProblem(
  check: SongCheck,
  bar: QualityBar,
): { kind: Exclude<ProblemKind, "copy" | "other">; text: string } | null {
  if (check.notAudio) return { kind: "notAudio", text: `It's ${check.notAudio}, not audio.` };
  if (check.cutShort) {
    const { plays, says } = check.cutShort;
    return {
      kind: "cutShort",
      text: `Plays ${formatDuration(plays)} of the ${formatDuration(says)} it says it is: the rest is missing.`,
    };
  }
  if (check.damaged) return { kind: "damaged", text: `Can't be read through: ${check.damaged}.` };
  if (bar === "off" || check.lossless) return null;
  const kbps = check.kbps === null ? "" : `${check.kbps} kbps`;
  if (bar === "lossless") {
    return {
      kind: "lowQuality",
      text: `${kbps || "Lossy"}${check.codec ? ` ${check.codec}` : ""}: not lossless.`,
    };
  }
  if (check.kbps !== null && check.kbps < Number(bar)) {
    return { kind: "lowQuality", text: `${kbps}: below ${bar} kbps.` };
  }
  return null;
}

// --- Extra copies ---------------------------------------------------------------------

/** A folder song and its check, as copiesOf() weighs it. */
export type CopyCandidate = {
  key: string;
  fileName: string;
  title: string;
  artist: string | null;
  album: string | null;
  genres: readonly string[];
  year: number | null;
  duration: number | null;
  /** When it arrived (ms since 1970). */
  addedAt: number;
  check: SongCheck;
};

// What makes a recording another version of a song, not a copy: "(Live)", "(Remix)"…
const VERSION_RE =
  /\b(?:live|remix(?:ed)?|mix|edit|extended|demo|acoustic|unplugged|instrumental|karaoke|reprise|cover|session|dub|version|radio|club|lpu|acapella|a cappella)\b/gi;
// A copy's "(1)", "- Copy".
const COPY_MARK_RE = /\(\d\)$|[\s-]+copy(?: \(\d\))?$/i;

const nameOf = (fileName: string) =>
  (fileName.split(/[\\/]/).pop() ?? fileName).replace(/\.[^.]+$/, "");

/**
 * Which copy to keep: lossless, then the highest bitrate, then a name without
 * "(1)", then the one with the most details, then the first there.
 */
function better(a: CopyCandidate, b: CopyCandidate): number {
  const details = (song: CopyCandidate) =>
    Number(!!song.artist) +
    Number(!!song.album) +
    Number(song.genres.length > 0) +
    Number(!!song.year);
  return (
    Number(b.check.lossless) - Number(a.check.lossless) ||
    (b.check.kbps ?? 0) - (a.check.kbps ?? 0) ||
    Number(COPY_MARK_RE.test(nameOf(a.fileName))) - Number(COPY_MARK_RE.test(nameOf(b.fileName))) ||
    details(b) - details(a) ||
    a.addedAt - b.addedAt
  );
}

/**
 * Extra copies: songs in the folder two or more times — the same artist and
 * title (tidied: "Linkin Park - Numb (1).mp3" with no tags is Linkin Park's
 * Numb), no more than SAME_LENGTH_SECONDS apart, and the same version (a "(Live)"
 * and a studio recording are two songs). For each song, the copy kept —
 * lossless, else the highest bitrate, then a name without a copy's "(1)",
 * then the most details, then the first one there — and the extra ones. A
 * song whose length isn't known is never called a copy.
 */
export function copiesOf(
  songs: readonly CopyCandidate[],
): { keep: CopyCandidate; extra: CopyCandidate[] }[] {
  const folder = folderArtistsOf(
    songs.map((song) => ({ name: nameOf(song.fileName), title: song.title, artist: song.artist })),
  );
  const bySong = new Map<string, { song: CopyCandidate; seconds: number }[]>();
  for (const song of songs) {
    const seconds = song.check.seconds ?? song.duration;
    if (!seconds) continue;
    const tidied = tidiedSong({ title: song.title, artist: song.artist }, folder);
    const versions = new Set(
      `${tidied.title} ${nameOf(song.fileName)}`.toLowerCase().match(VERSION_RE) ?? [],
    );
    const key = `${songKeyOf(tidied)}|${[...versions].sort().join(" ")}`;
    bySong.set(key, [...(bySong.get(key) ?? []), { song, seconds }]);
  }
  const sets: { keep: CopyCandidate; extra: CopyCandidate[] }[] = [];
  for (const same of bySong.values()) {
    if (same.length < 2) continue;
    same.sort((a, b) => a.seconds - b.seconds);
    // Runs of lengths each within SAME_LENGTH_SECONDS of the run's first.
    let run: typeof same = [];
    const close = () => {
      if (run.length >= 2) {
        const [keep, ...extra] = run.map(({ song }) => song).sort(better);
        sets.push({ keep, extra });
      }
    };
    for (const each of same) {
      if (run.length > 0 && each.seconds - run[0].seconds > SAME_LENGTH_SECONDS) {
        close();
        run = [];
      }
      run.push(each);
    }
    close();
  }
  return sets;
}
