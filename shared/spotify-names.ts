/**
 * Names for songs found from Spotify, shared by the server (searching YouTube,
 * tagging the file) and the page (naming the download).
 */

// Suffixes Spotify adds that name a release, not a different recording.
// "Song - Live" or "Song - Acoustic" are different recordings, so they stay.
const RELEASE_SUFFIX_RE =
  /^((\d{4} )?(digital(ly)? )?remaster(ed)?( \d{4})?( version)?|radio edit|single version|album version|mono( version)?|stereo( version)?|explicit|clean|bonus track)$/i;

/**
 * The song title as people write it on YouTube: "Bohemian Rhapsody -
 * Remastered 2011" → "Bohemian Rhapsody", "Get Lucky (feat. Pharrell
 * Williams…)" → "Get Lucky".
 */
export function cleanTrackTitle(title: string): string {
  let clean = title.replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "");
  const dash = clean.lastIndexOf(" - ");
  if (dash > 0 && RELEASE_SUFFIX_RE.test(clean.slice(dash + 3).trim()))
    clean = clean.slice(0, dash);
  return clean.replace(/\s+/g, " ").trim() || title.trim();
}

/**
 * What a song found from Spotify is saved as: "Artists - Title", the way music
 * folders usually name songs — "Queen - Bohemian Rhapsody" rather than the
 * YouTube video's "Queen – Bohemian Rhapsody (Official Video Remastered)".
 * `artists` as Spotify shows them ("Daft Punk, Pharrell Williams") or a list.
 * The server still makes it a safe file name (safeFileName).
 */
export function spotifyFileName(song: { title: string; artists: string | string[] }): string {
  const artists = (Array.isArray(song.artists) ? song.artists.join(", ") : song.artists).trim();
  const title = cleanTrackTitle(song.title);
  return artists ? `${artists} - ${title}` : title;
}
