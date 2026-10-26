import { api, buildUrl } from "@shared/routes";
import {
  folderFilesSchema,
  saveSettingsSchema,
  songCheckSchema,
  type FolderFile,
  type QualityBar,
  type SaveSettings,
  type SongCheck,
} from "@shared/schema";
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
export const problemKinds = ["notAudio", "cutShort", "damaged", "lowQuality", "other"] as const;
export type ProblemKind = (typeof problemKinds)[number];

export const problemHeadings: Record<ProblemKind, string> = {
  notAudio: "Not audio",
  cutShort: "Cut short",
  damaged: "Damaged",
  lowQuality: "Low quality",
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
): { kind: Exclude<ProblemKind, "other">; text: string } | null {
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
