import { useState } from "react";
import { downloadFormats, type DownloadFormat } from "@shared/routes";

const STORAGE_KEY = "download-format";

function loadSaved(): DownloadFormat {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as DownloadFormat | null;
    return saved && downloadFormats.includes(saved) ? saved : "mp3";
  } catch {
    return "mp3"; // storage unavailable (e.g. blocked) — use the default
  }
}

/** The download format picked last time on this browser; MP3 until the user switches. */
export function useDownloadFormat() {
  const [format, setFormatState] = useState<DownloadFormat>(loadSaved);

  const setFormat = (next: DownloadFormat) => {
    setFormatState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Can't remember it — the choice still applies for this visit.
    }
  };

  return [format, setFormat] as const;
}
