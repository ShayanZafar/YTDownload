/**
 * "Save to" folder: instead of the browser's own download (which always goes
 * to the browser's download folder), the page asks you to pick a folder once
 * and then writes finished files straight into it, using the File System
 * Access API. Chrome and Edge on a computer support this; everywhere else the
 * normal download is used.
 *
 * The folder is remembered between visits in IndexedDB (a folder "handle"
 * can't go in localStorage). The browser shows only its name, never the full
 * path, and asks once per visit (or "on every visit", if you allow it) before
 * the page may write there again.
 */

// Parts of the File System Access API that TypeScript's DOM types don't include yet.
type PermissionMode = { mode: "readwrite" };
export type SaveFolder = FileSystemDirectoryHandle & {
  queryPermission?(options: PermissionMode): Promise<PermissionState>;
  requestPermission?(options: PermissionMode): Promise<PermissionState>;
};
type DirectoryPicker = (options?: {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: string;
}) => Promise<SaveFolder>;

const pickerOf = (): DirectoryPicker | undefined =>
  typeof window === "undefined"
    ? undefined
    : (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;

/** Can this browser save into a folder you pick? (Chrome/Edge on a computer.) */
export function canPickFolder(): boolean {
  return typeof pickerOf() === "function" && typeof indexedDB !== "undefined";
}

/** Opens the folder picker. Resolves to undefined if you close it without picking. */
export async function pickFolder(): Promise<SaveFolder | undefined> {
  const picker = pickerOf();
  if (!picker) return undefined;
  try {
    return await picker({ id: "save-audio", mode: "readwrite", startIn: "music" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return undefined;
    throw err;
  }
}

/**
 * Makes sure the page may write to the folder, asking if needed. Call it
 * straight from a click — browsers only show the question in response to one.
 */
export async function ensureWriteAccess(folder: SaveFolder): Promise<boolean> {
  const mode: PermissionMode = { mode: "readwrite" };
  if (!folder.queryPermission) return true; // no permission model (e.g. private storage)
  if ((await folder.queryPermission(mode)) === "granted") return true;
  return (await folder.requestPermission?.(mode)) === "granted";
}

// --- Remembering the folder (IndexedDB) -----------------------------------

const DB_NAME = "yt-audio";
const STORE = "settings";
const FOLDER_KEY = "save-folder";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The folder picked last time, if any. Never throws — storage trouble just means "none". */
export async function loadRememberedFolder(): Promise<SaveFolder | undefined> {
  try {
    const folder = await withStore("readonly", (s) => s.get(FOLDER_KEY));
    return folder && typeof folder === "object" && "getFileHandle" in folder
      ? (folder as SaveFolder)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the folder for next time, or forgets it (undefined). Best effort. */
export async function rememberFolder(folder: SaveFolder | undefined): Promise<void> {
  try {
    if (folder) await withStore("readwrite", (s) => s.put(folder, FOLDER_KEY));
    else await withStore("readwrite", (s) => s.delete(FOLDER_KEY));
  } catch {
    // Can't remember it — the choice still applies for this visit.
  }
}

// --- Saving a download into the folder ------------------------------------

/**
 * The file name from a Content-Disposition header, made safe for Windows:
 * `attachment; filename="Me at the zoo.mp3"` → "Me at the zoo.mp3".
 */
export function fileNameFromDisposition(header: string | null, fallback = "audio"): string {
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header ?? "");
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header ?? "");
  let encoded = "";
  try {
    encoded = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")) : "";
  } catch {
    // Badly encoded — use the plain filename instead.
  }
  const name = Array.from(encoded || (plain?.[1] ?? plain?.[2] ?? ""))
    // Characters Windows doesn't allow in file names, and control characters.
    .map((ch) => ('\\/:*?"<>|'.includes(ch) || ch.charCodeAt(0) < 32 ? "_" : ch))
    .join("")
    .replace(/[. ]+$/, "")
    .trim();
  return name || fallback;
}

/** "Song.mp3", 2 → "Song (2).mp3" — the way browsers name a second copy. */
export function numberedName(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

async function exists(folder: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await folder.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    // TypeMismatchError: a folder with that name — treat the name as taken.
    if (err instanceof DOMException && err.name === "TypeMismatchError") return true;
    throw err;
  }
}

/** Human-readable size: 2_457_600 → "2.3 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SaveOptions = {
  /** Aborting cancels the download; the server then stops and records nothing. */
  signal?: AbortSignal;
  /** Called as audio arrives, with the bytes received so far. */
  onProgress?: (bytes: number) => void;
  fetchImpl?: typeof fetch;
};

/**
 * Downloads `url` into `folder` and returns the file name used. Never
 * overwrites: an existing "Song.mp3" makes this one "Song (1).mp3". If the
 * download fails or is cancelled, the unfinished file is removed.
 */
export async function saveToFolder(
  folder: FileSystemDirectoryHandle,
  url: string,
  { signal, onProgress, fetchImpl = fetch }: SaveOptions = {},
): Promise<string> {
  const res = await fetchImpl(url, { signal });
  if (!res.ok || !res.body) {
    const reason = (await res.text().catch(() => "")).trim();
    throw new Error(reason || `The download failed (HTTP ${res.status}).`);
  }

  const wanted = fileNameFromDisposition(res.headers.get("Content-Disposition"));
  let name = wanted;
  for (let n = 1; await exists(folder, name); n++) {
    if (n > 999) throw new Error(`Too many files named "${wanted}" in that folder.`);
    name = numberedName(wanted, n);
  }

  const file = await folder.getFileHandle(name, { create: true });
  let received = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress?.(received);
      controller.enqueue(chunk);
    },
  });
  try {
    // The browser writes to a temporary file and only swaps it in on success.
    const writable = await file.createWritable();
    await res.body.pipeThrough(counter).pipeTo(writable, { signal });
    return name;
  } catch (err) {
    await folder.removeEntry(name).catch(() => {});
    throw err;
  }
}
