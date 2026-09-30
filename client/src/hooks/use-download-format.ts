import { downloadFormats, type DownloadFormat } from "@shared/routes";
import { useStoredChoice } from "./use-stored-choice";

/** The download format picked last time on this browser; MP3 until the user switches. */
export function useDownloadFormat() {
  return useStoredChoice<DownloadFormat>("download-format", downloadFormats, "mp3");
}
