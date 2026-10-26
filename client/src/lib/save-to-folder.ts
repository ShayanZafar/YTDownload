/**
 * "Save to" folder, as the page sees it: the app itself saves downloads into a
 * folder on the computer it runs on, so it works the same in every browser.
 * The page only picks the folder (with the app's folder browser) and shows
 * progress. Only a browser on that computer can use it; see server/save.ts.
 */
import { z } from "zod";
import { api, errorSchemas, type DownloadFormat } from "@shared/routes";
import {
  folderEntrySchema,
  folderListingSchema,
  historyInFolderSchema,
  saveEventSchema,
  saveSettingsSchema,
  savedPlaylistFileSchema,
  songsInFolderSchema,
  type FolderEntry,
  type FolderListing,
  type HistoryInFolder,
  type PlaylistFileSong,
  type SaveEvent,
  type SaveSettings,
  type SavedPlaylistFile,
  type SongToFind,
  type SongsInFolder,
} from "@shared/schema";

/** A request the app turned down, with its reason and HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** YouTube refused it: it's limiting this computer (the app says so at once, in a 502). */
    readonly limited = false,
  ) {
    super(message);
  }
}

/** The app's error for a response that wasn't OK, from its JSON body (or the status alone). */
export async function errorFrom(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => undefined);
  const limited = errorSchemas.limited.safeParse(data);
  if (limited.success) return new ApiError(limited.data.message, res.status, true);
  const parsed = errorSchemas.internal.safeParse(data);
  return new ApiError(
    parsed.success ? parsed.data.message : `Something went wrong (HTTP ${res.status}).`,
    res.status,
  );
}

/**
 * The error for an OK answer that isn't what the page expected. A web page
 * instead of JSON means the app's server doesn't know the request: it's an
 * older version than the page (updated, but not restarted).
 */
export function unexpectedAnswer(res: Response): ApiError {
  if (res.headers.get("content-type")?.includes("text/html")) {
    return new ApiError(
      "The app needs restarting: it's still running an older version than this page. Stop it and start it again, then try again.",
      res.status,
    );
  }
  return new ApiError("The app sent an answer the page didn't expect.", res.status);
}

export async function requestJson<T>(
  schema: z.ZodType<T>,
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    ...(json === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
  });
  if (!res.ok) throw await errorFrom(res);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw unexpectedAnswer(res);
  return parsed.data;
}

/** Where downloads go, and whether this browser can save into a folder at all. */
export function fetchSaveSettings(): Promise<SaveSettings> {
  return requestJson(saveSettingsSchema, api.settings.get.path);
}

/** Saves into `folder` from now on, or the browser's downloads (null). */
export function updateSaveFolder(folder: string | null): Promise<SaveSettings> {
  return requestJson(saveSettingsSchema, api.settings.update.path, {
    method: api.settings.update.method,
    json: { saveFolder: folder },
  });
}

/** One folder's subfolders; with no path, where downloads go now (or Music). */
export function listFolders(path?: string, signal?: AbortSignal): Promise<FolderListing> {
  const query = path ? `?${new URLSearchParams({ path })}` : "";
  return requestJson(folderListingSchema, `${api.folders.list.path}${query}`, { signal });
}

/** Makes a folder called `name` inside `parent`. */
export function createFolder(parent: string, name: string): Promise<FolderEntry> {
  return requestJson(folderEntrySchema, api.folders.create.path, {
    method: api.folders.create.method,
    json: { parent, name },
  });
}

/** Which downloads in the history are in the "Save to" folder still (see server/library.ts). */
export function findHistoryInFolder(signal?: AbortSignal): Promise<HistoryInFolder> {
  return requestJson(historyInFolderSchema, api.downloads.inFolder.path, { signal });
}

/**
 * Which of these songs are already in the "Save to" folder (or its
 * subfolders) — the app looks at the files' tags and names.
 */
export function findSongsInFolder(
  songs: SongToFind[],
  signal?: AbortSignal,
): Promise<SongsInFolder> {
  return requestJson(songsInFolderSchema, api.folders.songs.path, {
    method: api.folders.songs.method,
    json: { songs },
    signal,
  });
}

/**
 * Writes the playlist's songs that are in the "Save to" folder into it as
 * "<name>.m3u8", in the playlist's order (replacing one the app wrote before).
 */
export function savePlaylistFile(
  name: string,
  songs: PlaylistFileSong[],
): Promise<SavedPlaylistFile> {
  return requestJson(savedPlaylistFileSchema, api.folders.playlistFile.path, {
    method: api.folders.playlistFile.method,
    json: { name, songs },
  });
}

export type SavedFile = Extract<SaveEvent, { type: "done" }>;

export type SaveOptions = {
  /** Aborting cancels the save: the app stops, removes the unfinished file and records nothing. */
  signal?: AbortSignal;
  /** Called as the audio arrives, with the bytes saved so far. */
  onProgress?: (bytes: number) => void;
  fetchImpl?: typeof fetch;
};

/**
 * Has the app download a video's audio into the "Save to" folder. Resolves
 * with the saved file (its name may have gained " (1)" if the name was taken);
 * rejects with the reason it failed — or, if cancelled, the fetch's AbortError.
 */
/**
 * What to download: a video, as MP3 or original audio, under a name (or its
 * title), maybe for a Spotify song.
 */
export type SaveRequest = {
  url: string;
  format: DownloadFormat;
  name?: string;
  spotifyId?: string;
};

/** A download being saved into the "Save to" folder (the page keys them by download link). */
export type ActiveSave = { bytes: number; folder: string; cancel: () => void };

export async function saveOnServer(
  request: SaveRequest,
  { signal, onProgress, fetchImpl = fetch }: SaveOptions = {},
): Promise<SavedFile> {
  const res = await fetchImpl(api.video.save.path, {
    method: api.video.save.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ApiError("This browser couldn't read the app's answer.", res.status);

  // One JSON object per line. Read with getReader(): Safari can't loop over a
  // stream with `for await`.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseSaveEvent(line);
      if (event?.type === "progress") onProgress?.(event.bytes);
      else if (event?.type === "done") return event;
      else if (event?.type === "error") throw new ApiError(event.message, res.status);
    }
    if (done) break;
  }
  throw new ApiError("The app stopped answering before the file was saved.", res.status);
}

/** One line of the save progress stream, or undefined if it isn't one. */
export function parseSaveEvent(line: string): SaveEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = saveEventSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** A folder's own name: "C:\Users\me\Music" → "Music", "D:\" → "D:", "/" → "/". */
export function folderName(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? path
  );
}
