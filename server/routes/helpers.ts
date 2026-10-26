/** What the route modules share: finding a folder song, sending one, and their errors. */
import type { Request, Response } from "express";
import { z } from "zod";
import { musicIdSchema } from "@shared/schema";
import { settings } from "../settings";
import { FolderError } from "../folders";
import { readTags, type AudioFile } from "../library";
import { findMusicFile } from "../music";

/** Replies with a folder problem's own status and message, or a 500 for anything else. */
export function sendFolderError(res: Response, err: unknown, fallback: string) {
  if (err instanceof FolderError) return res.status(err.status).json({ message: err.message });
  console.error(fallback, err);
  return res.status(500).json({ message: err instanceof Error ? err.message : fallback });
}

export const NO_FOLDER = "Choose a folder to save into first.";
export const SONG_GONE = "That song isn't in the folder any more.";
export const FILE_GONE = "That file isn't in the folder any more.";
export const PLAYER_NOT_LOCAL =
  "The songs in the Save to folder play only in a browser on the computer running the app.";

/**
 * The song a music request names (by id) in the "Save to" folder — or
 * undefined, having replied why not. A file that isn't audio by its content
 * (file-kind.ts) is never played, converted or read: only deleted
 * (`anyFile`). One that's another kind of audio than its name says comes
 * with that kind (`realType`).
 */
export async function songFor(
  req: Request,
  res: Response,
  { anyFile = false } = {},
): Promise<(AudioFile & { realType?: string }) | undefined> {
  const id = musicIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ message: id.error.issues[0].message });
    return undefined;
  }
  const { saveFolder } = await settings.get();
  if (!saveFolder) {
    res.status(409).json({ message: NO_FOLDER });
    return undefined;
  }
  const file = await findMusicFile(saveFolder, id.data);
  if (!file) {
    res.status(404).json({ message: SONG_GONE });
    return undefined;
  }
  const { notAudio, realType } = await readTags(file);
  if (notAudio && !anyFile) {
    res
      .status(415)
      .json({ message: `That isn't a song: it's ${notAudio}, whatever its name says.` });
    return undefined;
  }
  return { ...file, realType };
}

/** Sends an audio file as it is — range requests work, so the player can seek. */
export function sendAudioFile(res: Response, file: string, type: string) {
  res.sendFile(
    file,
    { dotfiles: "allow", headers: { "Content-Type": type, "Cache-Control": "no-cache" } },
    (err) => {
      // Sent, or the player hung up part-way (it often does, to jump elsewhere).
      if (!err || res.headersSent) return;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      console.error("Couldn't send a song:", err);
      res.status(500).json({ message: "Couldn't read that song." });
    },
  );
}

/** The first problem zod found, as `{ message, field }`. */
export function validationError(error: z.ZodError) {
  const [issue] = error.issues;
  return { message: issue.message, field: issue.path.join(".") };
}
