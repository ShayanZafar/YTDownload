import { useState } from "react";
import { History, ListMusic, X } from "lucide-react";
import type { RecentPlaylist } from "@/lib/recent-playlists";
import { cn } from "@/lib/utils";

type RecentPlaylistsProps = {
  playlists: readonly RecentPlaylist[];
  /** The link of the playlist open in the panel, if any. */
  openLink: string | null;
  onOpen: (link: string) => void;
  onForget: (link: string) => void;
};

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;

function Cover({ image }: { image: string | null }) {
  const [failed, setFailed] = useState(false);
  return image && !failed ? (
    <img
      src={image}
      alt=""
      onError={() => setFailed(true)}
      className="h-6 w-6 shrink-0 rounded object-cover"
    />
  ) : (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-secondary text-muted-foreground">
      <ListMusic className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * The playlists opened lately, under the box in Playlist mode: click one to
 * open it again (no need to find its link), × to take it off the list.
 */
export function RecentPlaylists({ playlists, openLink, onOpen, onForget }: RecentPlaylistsProps) {
  if (playlists.length === 0) return null;
  return (
    <nav aria-label="Recent playlists" className="w-full text-left">
      <p className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
        <History className="h-3.5 w-3.5" />
        Recent playlists
      </p>
      <ul className="flex flex-wrap gap-2">
        {playlists.map((playlist) => {
          const isOpen = playlist.link === openLink;
          const from = playlist.source === "youtube" ? "YouTube" : "Spotify";
          const what = `${from} ${playlist.kind}`;
          return (
            <li
              key={`${playlist.source}:${playlist.kind}:${playlist.id}`}
              className={cn(
                "flex max-w-full items-center rounded-full border bg-card pl-1 transition-colors",
                isOpen ? "border-primary/60 bg-primary/5" : "border-border hover:bg-secondary/60",
              )}
            >
              <button
                type="button"
                onClick={() => onOpen(playlist.link)}
                aria-current={isOpen ? "true" : undefined}
                aria-label={`${playlist.name}, ${what}, ${countSongs(playlist.songs)}`}
                title={[
                  what,
                  playlist.by && `by ${playlist.by}`,
                  countSongs(playlist.songs),
                  isOpen && "open below (click to reload)",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                className="flex min-w-0 items-center gap-2 py-1 pr-1 text-xs font-medium text-foreground"
              >
                <Cover image={playlist.image} />
                <span className="max-w-48 truncate">{playlist.name}</span>
              </button>
              <button
                type="button"
                onClick={() => onForget(playlist.link)}
                aria-label={`Take “${playlist.name}” off the recent playlists`}
                title="Take it off this list"
                className="mr-1 shrink-0 rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
