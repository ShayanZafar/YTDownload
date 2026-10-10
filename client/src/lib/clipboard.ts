import { extractVideoId } from "@shared/youtube-link";
import { asLink } from "@/lib/format";

/**
 * The clipboard, for the main box: the Paste button, and a link you've
 * copied, suggested under the empty box where the browser lets the page look
 * without asking each time.
 *
 * Browsers let a page read the clipboard only in a secure context: this
 * computer's own http://localhost, or https — not plain http from another
 * device, like a phone on the Wi-Fi. Chrome and Edge ask once ("See text and
 * images copied to the clipboard"); once that's allowed, the page may look
 * whenever it's in front, which is when the box suggests a copied link.
 * Firefox and Safari confirm every read with a Paste button of their own, so
 * there the page looks only when Paste is clicked.
 */

/** A link the box opens, found in copied text. */
export type CopiedLink = {
  kind: "youtube" | "spotify";
  /** As copied ("youtu.be/…" gains "https://"). */
  url: string;
  /** The same video or song however its link was copied ("youtube:<video id>"). */
  key: string;
  /** The link, short, to show in a small space: "youtu.be/<video id>". */
  label: string;
};

// Copied text is looked through this far (a long message, not a whole book).
const MAX_TEXT = 5_000;
// Text pasted into the box is cut short here.
const MAX_PASTE = 300;

// Punctuation around a link in a sentence or a message: "(https://…).", "<https://…>".
const AROUND_LINK = /^["'([{<«“‘]+|["')\]}>»”’.,;:!?]+$/g;

// The Spotify links the box opens: songs, playlists and albums (not artists
// or podcasts) — and spotify.link short links, which lead to one of those.
const SPOTIFY_SHORT_LINK =
  /^(?:https?:\/\/)?(spotify\.(?:app\.)?link)\/([A-Za-z0-9_-]{1,64})\/?(?:[?#]\S*)?$/i;
const SPOTIFY_LINK =
  /^(?:spotify:(track|playlist|album):([A-Za-z0-9]{22})|(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|playlist|album)\/([A-Za-z0-9]{22})(?:[/?#]\S*)?)$/i;

/**
 * The first YouTube video link or Spotify song, playlist or album link in some
 * copied text — a link on its own, or in a message shared from an app.
 */
export function findCopiedLink(text: string): CopiedLink | undefined {
  for (const word of text.slice(0, MAX_TEXT).split(/\s+/)) {
    const candidate = word.replace(AROUND_LINK, "");
    if (!candidate) continue;
    const link = asLink(candidate);
    const videoId = link ? extractVideoId(link) : null;
    if (link && videoId) {
      return {
        kind: "youtube",
        url: link,
        key: `youtube:${videoId}`,
        label: `youtu.be/${videoId}`,
      };
    }
    const spotify = SPOTIFY_LINK.exec(candidate);
    if (spotify) {
      const kind = (spotify[1] ?? spotify[3]).toLowerCase();
      const id = spotify[2] ?? spotify[4];
      return {
        kind: "spotify",
        url: candidate,
        key: `spotify:${kind}:${id}`,
        label: `spotify.com/${kind}/${id}`,
      };
    }
    const short = SPOTIFY_SHORT_LINK.exec(candidate);
    if (short) {
      return {
        kind: "spotify",
        url: /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
        key: `spotify:short:${short[2]}`,
        label: `${short[1].toLowerCase()}/${short[2]}`,
      };
    }
  }
  return undefined;
}

/** Copied text to put in the box: one line, trimmed, not too long. */
export function textToPaste(text: string): string {
  return text.slice(0, MAX_TEXT).replace(/\s+/g, " ").trim().slice(0, MAX_PASTE).trim();
}

/** Can this page read the clipboard at all? (Not over plain http from another device.) */
export function canReadClipboard(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.clipboard?.readText === "function"
  );
}

/**
 * The page's permission to read the clipboard without the browser asking —
 * "granted" once you've allowed it in Chrome or Edge, "denied" once you've
 * blocked it — or null where every read is confirmed instead (Firefox and
 * Safari don't know "clipboard-read").
 */
export async function clipboardPermission(): Promise<PermissionStatus | null> {
  try {
    const name = "clipboard-read" as PermissionName;
    return (await navigator.permissions?.query({ name })) ?? null;
  } catch {
    return null;
  }
}

/** The keys that paste: ⌘V on a Mac (or an iPad), Ctrl+V everywhere else. */
export function pasteKeys(platform: string): string {
  return /^(Mac|iPhone|iPad|iPod)/.test(platform) ? "⌘V" : "Ctrl+V";
}
