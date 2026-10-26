import { useState, type FormEvent } from "react";
import { Copy, ListMusic, LogIn, LogOut, Settings2 } from "lucide-react";
import type { OwnPlaylist } from "@shared/schema";
import { useSpotifyAccount } from "@/hooks/use-spotify-account";
import { SPOTIFY_DASHBOARD } from "@/lib/spotify-account";
import { cn } from "@/lib/utils";

type SpotifyAccountProps = {
  /** The link of the playlist open in the panel, if any. */
  openLink: string | null;
  onOpen: (link: string) => void;
};

const countSongs = (n: number) => `${n.toLocaleString()} ${n === 1 ? "song" : "songs"}`;
const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-60";

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
 * Setting up Spotify sign-in: Spotify lets an app read a playlist's songs
 * only for the person signed in, and only through an app of their own, so
 * this walks through making one and pasting its Client ID.
 */
function ClientIdSetup({
  redirectUri,
  current,
  onSave,
  isSaving,
  error,
  onCancel,
}: {
  redirectUri: string;
  current: string | null;
  onSave: (id: string | null) => void;
  isSaving: boolean;
  error: string | null;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(current ?? "");
  const [copied, setCopied] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(text.trim() || null);
  };
  const copy = () =>
    void navigator.clipboard?.writeText(redirectUri).then(
      () => setCopied(true),
      () => {},
    );
  return (
    <form
      onSubmit={submit}
      aria-label="Set up Spotify sign-in"
      className="space-y-2 rounded-xl border border-border bg-card p-3 text-left text-xs text-muted-foreground"
    >
      <p className="text-sm font-medium text-foreground">Set up Spotify sign-in (once)</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          Open the{" "}
          <a
            href={SPOTIFY_DASHBOARD}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline"
          >
            Spotify developer dashboard
          </a>{" "}
          and choose <b>Create app</b>. Any name and description will do. Spotify needs the app's
          owner to have Premium.
        </li>
        <li>
          Under <b>Redirect URIs</b>, add{" "}
          <code className="rounded bg-secondary px-1 py-0.5 text-foreground">{redirectUri}</code>{" "}
          <button
            type="button"
            onClick={copy}
            aria-label="Copy the Redirect URI"
            className="inline-flex items-center gap-1 align-middle text-primary hover:underline"
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy"}
          </button>
        </li>
        <li>
          Tick <b>Web API</b>, save, and paste the app's <b>Client ID</b> here:
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Spotify Client ID"
          placeholder="32 letters and digits"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
        />
        <button type="submit" disabled={isSaving} className={buttonClass}>
          Save
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={buttonClass}>
            Cancel
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}

function YourPlaylists({
  playlists,
  openLink,
  onOpen,
}: {
  playlists: OwnPlaylist[];
  openLink: string | null;
  onOpen: (link: string) => void;
}) {
  if (playlists.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground">You have no playlists on Spotify yet.</p>
    );
  }
  return (
    <ul
      aria-label="Your Spotify playlists"
      className="flex max-h-40 flex-wrap gap-2 overflow-y-auto"
    >
      {playlists.map((playlist) => {
        const isOpen = playlist.url === openLink;
        return (
          <li key={playlist.id}>
            <button
              type="button"
              onClick={() => onOpen(playlist.url)}
              aria-current={isOpen ? "true" : undefined}
              aria-label={`${playlist.name}, ${countSongs(playlist.songs)}`}
              title={[playlist.by && `by ${playlist.by}`, countSongs(playlist.songs)]
                .filter(Boolean)
                .join(" · ")}
              className={cn(
                "flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-xs font-medium text-foreground transition-colors",
                isOpen ? "border-primary/60 bg-primary/5" : "border-border hover:bg-secondary/60",
              )}
            >
              <Cover image={playlist.image} />
              <span className="max-w-48 truncate">{playlist.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Spotify sign-in, under the box in Playlist mode: set up once with your own
 * Spotify app's Client ID, then sign in, and the playlists you made or
 * collaborate on list whole (not just their first 100 songs). Signed in, your
 * playlists are listed here to open with a click. Only on the computer
 * running the app: another device just doesn't show it.
 */
export function SpotifyAccount({ openLink, onOpen }: SpotifyAccountProps) {
  const { account, playlists, clientId, signIn, signOut } = useSpotifyAccount();
  const [settingUp, setSettingUp] = useState(false);
  if (!account?.canSignIn) return null;

  const error = (signIn.error ?? signOut.error)?.message ?? (account.error || null);

  if (!account.clientId || settingUp) {
    if (!account.clientId && !settingUp) {
      return (
        <div className="flex w-full flex-wrap items-center gap-2 px-1 text-left text-xs text-muted-foreground">
          <span>
            Spotify shares only the first 100 songs of a playlist. Signed in, yours list whole.
          </span>
          <button type="button" onClick={() => setSettingUp(true)} className={buttonClass}>
            <Settings2 className="h-3.5 w-3.5" />
            Set up Spotify sign-in
          </button>
        </div>
      );
    }
    return (
      <div className="w-full">
        <ClientIdSetup
          redirectUri={account.redirectUri}
          current={account.clientId}
          isSaving={clientId.isPending}
          error={clientId.error?.message ?? null}
          onSave={(id) => clientId.mutate(id, { onSuccess: () => setSettingUp(false) })}
          onCancel={() => setSettingUp(false)}
        />
      </div>
    );
  }

  return (
    <section aria-label="Spotify sign-in" className="w-full space-y-2 text-left">
      <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
        {account.signedInAs ? (
          <>
            <span>
              Signed in to Spotify as{" "}
              <b className="text-foreground" data-testid="spotify-signed-in-as">
                {account.signedInAs}
              </b>
              : your own playlists list whole.
            </span>
            <button
              type="button"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
              className={buttonClass}
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </>
        ) : (
          <>
            <span>Sign in to list every song of your own playlists.</span>
            <button
              type="button"
              onClick={() => signIn.mutate()}
              disabled={signIn.isPending}
              className={buttonClass}
            >
              <LogIn className="h-3.5 w-3.5" />
              Sign in with Spotify
            </button>
            <button
              type="button"
              onClick={() => setSettingUp(true)}
              className="text-primary hover:underline"
            >
              Change Client ID
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="px-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {account.signedInAs &&
        (playlists.data ? (
          <YourPlaylists playlists={playlists.data} openLink={openLink} onOpen={onOpen} />
        ) : playlists.error ? (
          <p role="alert" className="px-1 text-xs text-destructive">
            {playlists.error.message}
          </p>
        ) : (
          <p className="px-1 text-xs text-muted-foreground">Loading your playlists…</p>
        ))}
    </section>
  );
}
