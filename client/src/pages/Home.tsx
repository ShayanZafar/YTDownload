import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { Layout } from "@/components/layout";
import { FindBox, inputModes, type InputMode } from "@/components/find-box";
import { PreviewCard, defaultNameOf, type Selected } from "@/components/preview-card";
import { SearchResults } from "@/components/search-results";
import { RecentExtractions } from "@/components/recent-extractions";
import { SaveToSetting } from "@/components/save-to-setting";
import { ActiveSaves } from "@/components/active-saves";
import { FolderPicker } from "@/components/folder-picker";
import { RecentPlaylists } from "@/components/recent-playlists";
import { SpotifyAccount } from "@/components/spotify-account";
import { SpotifyPlaylistPanel } from "@/components/spotify-playlist";
import { MusicLibrary } from "@/components/music-library";
import {
  useVideoInfo,
  useRecentDownloads,
  useSongSearch,
  useSpotifyLink,
  usePlaylist,
} from "@/hooks/use-youtube";
import { useDownloadFormat } from "@/hooks/use-download-format";
import { useStoredChoice } from "@/hooks/use-stored-choice";
import { useStoredValue } from "@/hooks/use-stored-value";
import { useSaveSettings } from "@/hooks/use-save-settings";
import { SONGS_IN_FOLDER_KEY, useSongsInFolder } from "@/hooks/use-songs-in-folder";
import { MUSIC_KEY, useFolderMusic } from "@/hooks/use-folder-music";
import { downloadAllToast, useDownloadAll } from "@/hooks/use-download-all";
import { useClipboardLink } from "@/hooks/use-clipboard-link";
import { usePlayer } from "@/hooks/use-player";
import { useRecentPlaylists } from "@/hooks/use-recent-playlists";
import { asLink, isSpotifyLink, isSpotifyShortLink, playlistSourceOf } from "@/lib/format";
import {
  canReadClipboard,
  clipboardPermission,
  findCopiedLink,
  pasteKeys,
  textToPaste,
} from "@/lib/clipboard";
import {
  ApiError,
  folderName,
  saveOnServer,
  savePlaylistFile,
  type ActiveSave,
  type SaveRequest,
} from "@/lib/save-to-folder";
import { folderTrack, playlistQueue } from "@/lib/music";
import { recentPlaylistOf } from "@/lib/recent-playlists";
import { queryClient } from "@/lib/queryClient";
import { api, buildDownloadUrl } from "@shared/routes";
import { spotifyFileName } from "@shared/spotify-names";
import { extractVideoId } from "@shared/youtube-link";
import type {
  SearchResult,
  SpotifyPlaylist,
  SpotifyPlaylistTrack,
  SpotifyTrack,
} from "@shared/schema";

// A download started from this page that hasn't shown up in the history yet.
// The server only records a download once it has fully completed, so we keep
// refreshing the history until it appears — or give up after a while, since
// a cancelled download never will.
type PendingDownload = { url: string; afterId: number; startedAt: number };
const PENDING_TIMEOUT_MS = 15 * 60_000;
const HISTORY_POLL_MS = 3_000;

export default function Home() {
  const [text, setText] = useState("");
  const [mode, setMode] = useStoredChoice<InputMode>("input-mode", inputModes, "link");
  const [selected, setSelected] = useState<Selected | null>(null);
  // The name to save the selected video's audio under; null = its title.
  const [fileName, setFileName] = useState<string | null>(null);
  const [format, setFormat] = useDownloadFormat();
  const isOriginal = format === "original";
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingDownload[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  // The clipboard: a Paste button where the page may read it, and a link you've
  // copied suggested under the empty box where it may look unasked (lib/clipboard.ts).
  const copied = useClipboardLink();
  const [canPaste] = useState(canReadClipboard);
  const previewRef = useRef<HTMLElement>(null);
  const [scrollRequest, setScrollRequest] = useState(0);
  const saveTo = useSaveSettings();
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [saves, setSaves] = useState<Record<string, ActiveSave>>({});
  const isSaving = Object.keys(saves).length > 0;
  // The Spotify playlist (or album) or YouTube playlist open in the panel,
  // remembered for next time.
  const [playlistLink, setPlaylistLink] = useStoredValue("spotify-playlist");
  const playlist = usePlaylist(playlistLink);
  const playlistSource = (playlistLink !== null && playlistSourceOf(playlistLink)) || "spotify";
  // The playlists opened lately, to open again with a click.
  const recentPlaylists = useRecentPlaylists();
  const { remember: rememberPlaylist } = recentPlaylists;
  useEffect(() => {
    if (playlistLink !== null && playlist.data) {
      rememberPlaylist(recentPlaylistOf(playlistLink, playlist.data));
    }
  }, [playlistLink, playlist.data, rememberPlaylist]);
  // The playlist song being looked for on YouTube.
  const [pendingTrackId, setPendingTrackId] = useState<string>();
  // With a "Save to" folder: which of the playlist's songs are in it already.
  const folderSongs = useSongsInFolder(playlistLink !== null ? saveTo.folder : null, playlist.data);
  // "Download all": the playlist's missing songs, found and saved as many at
  // once as the app's computer has CPU cores.
  const downloadAll = useDownloadAll({
    atOnce: saveTo.settings?.cpuCores,
    onSaved: () => {
      void queryClient.invalidateQueries({ queryKey: [api.downloads.list.path] });
      void queryClient.invalidateQueries({ queryKey: MUSIC_KEY });
    },
    onDone: (summary) => {
      void queryClient.invalidateQueries({ queryKey: SONGS_IN_FOLDER_KEY });
      if (summary.problem) void saveTo.refresh();
      toast(downloadAllToast(summary, saveTo.folder));
    },
  });
  // The playlist's songs that are in the folder, for Play and Save playlist file.
  const folderMusic = useFolderMusic(playlistLink !== null ? saveTo.folder : null);
  const playlistInFolder = useMemo(
    () =>
      playlistQueue(
        playlist.data?.tracks ?? [],
        folderSongs.data?.found ?? {},
        (folderMusic.data?.tracks ?? []).map(folderTrack),
      ),
    [playlist.data, folderSongs.data, folderMusic.data],
  );
  const { mutate: writePlaylistFile, isPending: isSavingPlaylistFile } = useMutation({
    mutationFn: (list: SpotifyPlaylist) =>
      savePlaylistFile(
        list.name,
        list.tracks.map(({ id, title, artists, duration }) => ({ id, title, artists, duration })),
      ),
    onSuccess: (saved) =>
      toast({
        title: `Saved “${saved.file}”`,
        description: [
          `${saved.songs} ${saved.songs === 1 ? "song" : "songs"} in ${
            saveTo.folder ? `“${folderName(saveTo.folder)}”` : "the folder"
          }${saved.replaced ? " (the earlier one is updated)" : ""}.`,
          saved.missing > 0 &&
            `${saved.missing} not in the folder yet — save it again after downloading them.`,
        ]
          .filter(Boolean)
          .join(" "),
      }),
    onError: (err) =>
      toast({
        title: "Couldn't save the playlist file",
        description: err.message,
        variant: "destructive",
      }),
  });
  const { reset: resetDownloadAll } = downloadAll;
  // Another playlist (or none): the last run's marks no longer apply. A run
  // still going isn't stopped by it — only by its Stop button.
  useEffect(() => resetDownloadAll(), [playlistLink, resetDownloadAll]);

  const {
    mutate: fetchInfo,
    isPending: isFetchingInfo,
    error: infoError,
    reset: resetInfo,
  } = useVideoInfo();
  const {
    mutate: search,
    isPending: isSearching,
    data: searchData,
    variables: searchedFor,
    error: searchError,
    reset: resetSearch,
  } = useSongSearch();
  const { data: recentDownloads, isLoading: isLoadingHistory } = useRecentDownloads(
    pending.length > 0 ? HISTORY_POLL_MS : false,
  );
  const { mutate: openShortLink, isPending: isOpeningShortLink } = useSpotifyLink();
  const results = searchData?.results;
  // The search result whose video plays in the list (one at a time), by its id.
  const [previewing, setPreviewing] = useState<string | null>(null);
  useEffect(() => setPreviewing(null), [searchData]);
  const player = usePlayer();
  // A download's song to find in Your music (In folder, in Recent Extractions).
  const [locating, setLocating] = useState<{ id: string } | null>(null);
  const spotify = searchData?.spotify;
  const isBusy = isFetchingInfo || isSearching || isOpeningShortLink;
  // A copied link, suggested while the box is empty — unless it's already open.
  const openLinks = [selected?.url, playlistLink].map((link) => link && findCopiedLink(link)?.key);
  const suggestion =
    copied.link && !text.trim() && !isBusy && !openLinks.includes(copied.link.key)
      ? copied.link
      : null;

  const allHistory = useMemo(() => recentDownloads ?? [], [recentDownloads]);
  const error = infoError ?? searchError;
  // Songs in the history by their Spotify id, and videos by their YouTube id,
  // so the playlist can mark them.
  const downloadedIds = useMemo(
    () =>
      new Set(
        allHistory.flatMap((d) =>
          [d.spotifyId, extractVideoId(d.url)].filter((id): id is string => !!id),
        ),
      ),
    [allHistory],
  );

  // Stop waiting for a download once it's in the history (or has timed out).
  useEffect(() => {
    if (pending.length === 0) return;
    const prune = () =>
      setPending((current) =>
        current.filter(
          (p) =>
            Date.now() - p.startedAt < PENDING_TIMEOUT_MS &&
            !recentDownloads?.some((d) => d.url === p.url && d.id > p.afterId),
        ),
      );
    prune();
    const timer = setInterval(prune, 30_000);
    return () => clearInterval(timer);
  }, [recentDownloads, pending.length]);

  // Leaving the page cancels saves into the folder (the app stops when the page
  // goes away), so ask first — the browser shows its own "Leave site?" prompt.
  const isBusySaving = isSaving || downloadAll.running;
  useEffect(() => {
    if (!isBusySaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ""; // older browsers need this too
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isBusySaving]);

  // After picking a search result, bring the preview card (with its Download
  // button) into view — it sits above the results list.
  useEffect(() => {
    if (scrollRequest === 0) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    previewRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
    });
  }, [scrollRequest]);

  const watchForDownload = (downloadUrl: string) => {
    const afterId = Math.max(0, ...(recentDownloads ?? []).map((d) => d.id));
    setPending((current) => [...current, { url: downloadUrl, afterId, startedAt: Date.now() }]);
  };

  const extract = (link: string) => {
    fetchInfo(link, {
      onSuccess: (info) => showVideo(info),
      onError: (err) => {
        toast({
          title: "Couldn't fetch video",
          description: err.message,
          variant: "destructive",
        });
      },
    });
  };

  // `soundCloudOnly`: look on SoundCloud alone (YouTube refused the song, or you asked).
  const runSearch = (query: string, playlistTrackId?: string, soundCloudOnly = false) => {
    setPendingTrackId(playlistTrackId);
    search(
      { query, soundCloudOnly },
      {
        // A Spotify link asks for one particular song: show the best match
        // straight away (the other matches stay listed below).
        onSuccess: (data) => {
          if (data.spotify && data.results[0]) pick(data.results[0], data.spotify);
        },
        onError: (err) => {
          toast({ title: "Search failed", description: err.message, variant: "destructive" });
        },
      },
    );
  };

  // Opens a Spotify playlist or album, or a YouTube playlist, in the panel (or
  // reloads it, if it's open).
  const openPlaylist = (link: string) => {
    if (link === playlistLink) void playlist.refetch();
    else setPlaylistLink(link);
  };

  // A song picked in the playlist panel: a Spotify song is found on YouTube,
  // like its Spotify link; a YouTube playlist's video opens straight away.
  const pickPlaylistSong = (track: SpotifyPlaylistTrack) => {
    if (playlist.data?.source !== "youtube") return runSearch(track.url, track.id);
    resetSearch();
    pick({
      id: track.id,
      url: track.url,
      title: track.title,
      channel: track.artists,
      duration: track.duration,
      thumbnail: track.thumbnail ?? `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`,
      official: false,
    });
  };

  // Whatever the mode, a YouTube link is opened, a Spotify playlist or album
  // link or a YouTube playlist link opens the playlist panel, and anything
  // else is searched for — switching the toggle to match, so pasting a link
  // into the search box works. A Spotify song link is a search for that song.
  const submit = (value: string) => {
    // A link opened here isn't suggested again (until something else is copied).
    const copiedLink = findCopiedLink(value);
    if (copiedLink) copied.handle(copiedLink.key);

    // A spotify.link short link: ask the app where it leads, then go on as
    // if that open.spotify.com link had been typed.
    if (isSpotifyShortLink(value)) {
      openShortLink(value, {
        onSuccess: (data) => submit(data.url),
        onError: (err) => {
          toast({
            title: "Couldn't open the Spotify link",
            description: err.message,
            variant: "destructive",
          });
        },
      });
      return;
    }
    const playlistFrom = playlistSourceOf(value);
    if (playlistFrom) {
      if (mode !== "playlist") setMode("playlist");
      openPlaylist(playlistFrom === "youtube" ? (asLink(value) ?? value) : value);
      return;
    }
    const link = isSpotifyLink(value) ? undefined : asLink(value);
    if (link) {
      if (mode !== "link") setMode("link");
      extract(link);
    } else {
      if (mode !== "search") setMode("search");
      runSearch(value);
    }
  };

  // A link or text put in the box for you (Paste, or the copied link
  // suggested under it), then handled as if typed and submitted.
  const fillAndSubmit = (value: string) => {
    setText(value);
    if (infoError) resetInfo();
    if (searchError) resetSearch();
    submit(value);
  };

  // Paste: the clipboard's text goes in the box, on one line, and on as if
  // typed — a YouTube link opens, a Spotify playlist opens in the panel, and
  // anything else is searched for.
  const pasteFromClipboard = async () => {
    let clipboardText: string;
    try {
      clipboardText = await navigator.clipboard.readText();
    } catch {
      // Refused. Dismissing the browser's own question — Firefox's and
      // Safari's Paste button, or Chrome's and Edge's "Allow?" the first
      // time — is a no: nothing happens. Chrome and Edge also refuse when
      // they're set to block the clipboard ("denied"): then say how to allow it.
      const permission = (await clipboardPermission())?.state;
      if (permission !== "denied" && permission !== "granted") return;
      const keys = pasteKeys(navigator.platform);
      inputRef.current?.focus();
      toast(
        permission === "denied"
          ? {
              title: "The browser blocked the clipboard",
              description: `To allow it, click the icon left of the address bar and turn on Clipboard. Or press ${keys} in the box.`,
            }
          : {
              title: "Couldn't read the clipboard",
              description: `Press ${keys} in the box instead.`,
            },
      );
      return;
    }
    const value = textToPaste(clipboardText);
    if (value) fillAndSubmit(value);
    else toast({ title: "Nothing to paste", description: "The clipboard has no text." });
  };

  // A newly chosen video starts out saved under its own title.
  const showVideo = (video: Selected | null) => {
    setSelected(video);
    setFileName(null);
  };

  // `song`: the Spotify song these results were found for, if any.
  const pick = (result: SearchResult, song?: SpotifyTrack) => {
    resetInfo();
    showVideo({
      url: result.url,
      title: result.title,
      thumbnail: result.thumbnail,
      channel: result.channel,
      duration: result.duration,
      spotifyId: song?.id,
      fileTitle: song ? spotifyFileName(song) : undefined,
      source: result.source,
    });
    setScrollRequest((n) => n + 1);
  };

  // Opens a result's video in the list (closing any other), or closes it. The
  // app's own player pauses, so the two don't play over each other.
  const togglePreview = (id: string) => {
    if (previewing === id) return setPreviewing(null);
    if (player.status === "playing") player.toggle();
    setPreviewing(id);
  };

  const clear = () => {
    resetInfo();
    resetSearch();
    showVideo(null);
    setText("");
    inputRef.current?.focus();
  };

  // Picked in the folder browser. If the app can't use the folder, this
  // rejects and the browser shows why, staying open.
  const chooseFolder = async (folder: string) => {
    const settings = await saveTo.setFolder(folder);
    toast({
      title: `Saving to “${folderName(settings.saveFolder ?? folder)}”`,
      description: "Downloads from this page will go straight into that folder.",
    });
  };

  const switchToBrowserDownloads = () => {
    saveTo.setFolder(null).catch((err: unknown) =>
      toast({
        title: "Couldn't change where downloads go",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      }),
    );
  };

  // Downloads into the "Save to" folder: the app saves the file itself, and
  // the page shows progress on the button instead of the browser's download
  // bar. Cancelling stops the app's work, as with a normal download.
  // `soundCloudQuery`: what to look for on SoundCloud if YouTube refuses it.
  const saveIntoFolder = async (
    href: string,
    request: SaveRequest,
    folder: string,
    title: string,
    soundCloudQuery?: string,
  ) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    setSaves((current) => ({ ...current, [href]: { title, bytes: 0, folder, cancel } }));
    try {
      const saved = await saveOnServer(request, {
        signal: controller.signal,
        onProgress: (bytes) =>
          setSaves((current) =>
            current[href] ? { ...current, [href]: { ...current[href], bytes } } : current,
          ),
      });
      toast({ title: `Saved to “${folderName(saved.folder)}”`, description: saved.path });
      void queryClient.invalidateQueries({ queryKey: [api.downloads.list.path] });
      void queryClient.invalidateQueries({ queryKey: SONGS_IN_FOLDER_KEY });
      void queryClient.invalidateQueries({ queryKey: MUSIC_KEY });
    } catch (err) {
      if (controller.signal.aborted) {
        toast({ title: "Download cancelled" });
        return;
      }
      // The folder may be gone or off-limits now, or changed in another tab.
      if (err instanceof ApiError && [403, 404, 409].includes(err.status)) void saveTo.refresh();
      // YouTube refused it: SoundCloud may have the song.
      const findElsewhere = err instanceof ApiError && err.limited && soundCloudQuery;
      toast({
        title: "Couldn't save the audio",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
        ...(findElsewhere && {
          action: (
            <ToastAction
              altText="Look for this song on SoundCloud"
              onClick={() => runSearch(soundCloudQuery, undefined, true)}
            >
              Find on SoundCloud
            </ToastAction>
          ),
        }),
      });
    } finally {
      setSaves(({ [href]: _done, ...rest }) => rest);
    }
  };

  // Every download link goes through here: with a "Save to" folder the app
  // saves the file itself; otherwise the browser downloads it as usual.
  // `title`: what the song is called while it's saved.
  const startDownload = (
    event: React.MouseEvent,
    href: string,
    request: SaveRequest,
    title: string,
    soundCloudQuery?: string,
  ) => {
    if (saveTo.folder) {
      event.preventDefault();
      if (!saves[href]) void saveIntoFolder(href, request, saveTo.folder, title, soundCloudQuery);
      return false;
    }
    watchForDownload(request.url);
    return true;
  };

  const handleDownload = (event: React.MouseEvent) => {
    if (!selected) return;
    const request = {
      url: selected.url,
      format,
      name: fileName ?? selected.fileTitle,
      spotifyId: selected.spotifyId,
    };
    // If YouTube refuses it: the Spotify song (found by its length again), or the video's title.
    const soundCloudQuery =
      selected.source === "soundcloud"
        ? undefined
        : selected.spotifyId
          ? `https://open.spotify.com/track/${selected.spotifyId}`
          : selected.title;
    const title = request.name ?? defaultNameOf(selected);
    if (!startDownload(event, selectedHref, request, title, soundCloudQuery)) return;

    toast({
      title: "Download Started",
      description: isOriginal
        ? `Fetching the original audio from ${selected.source === "soundcloud" ? "SoundCloud" : "YouTube"}. It'll appear in Recent Extractions once it finishes.`
        : "Converting to MP3. It'll appear in Recent Extractions once it finishes.",
    });
  };

  const selectedHref = selected
    ? buildDownloadUrl(selected.url, format, {
        name: fileName ?? selected.fileTitle,
        spotifyId: selected.spotifyId,
      })
    : "";
  const selectedSave = saves[selectedHref];
  // The selected song is in the history already: its button says so, and downloads it again.
  const selectedId = selected && extractVideoId(selected.url);
  const selectedDone =
    !!selected &&
    allHistory.some(
      (d) =>
        d.url === selected.url ||
        (!!selected.spotifyId && d.spotifyId === selected.spotifyId) ||
        (!!selectedId && extractVideoId(d.url) === selectedId),
    );

  return (
    <Layout>
      {/* Hero Section */}
      <section className="flex flex-col items-center text-center space-y-6 w-full max-w-2xl mx-auto pt-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary text-secondary-foreground text-sm font-medium border border-border">
          <span className="flex h-2 w-2 rounded-full bg-primary" />
          High Quality Audio Extraction
        </div>

        <h1 className="text-3xl sm:text-4xl md:text-6xl font-display font-extrabold tracking-tight text-foreground leading-[1.1]">
          Convert any YouTube video to{" "}
          <span className="text-transparent bg-clip-text bg-linear-to-r from-primary/80 to-primary">
            pure audio.
          </span>
        </h1>

        <p className="text-lg text-muted-foreground leading-relaxed max-w-xl">
          Paste a link or search for a song to extract crisp, high-quality audio from your favorite
          music, videos, podcasts, and lectures.
        </p>

        <FindBox
          mode={mode}
          onModeChange={setMode}
          text={text}
          onTextChange={(value) => {
            setText(value);
            if (infoError) resetInfo();
            if (searchError) resetSearch();
          }}
          onSubmit={submit}
          isBusy={isBusy}
          isSearching={isSearching}
          canPaste={canPaste}
          onPaste={() => void pasteFromClipboard()}
          canSuggest={copied.canSuggest}
          suggestion={suggestion}
          onOpenSuggestion={fillAndSubmit}
          onDismissSuggestion={copied.handle}
          onFocusEmpty={() => void copied.check()}
          inputRef={inputRef}
        />

        {mode === "playlist" && (
          <>
            <SpotifyAccount openLink={playlistLink} onOpen={openPlaylist} />
            <RecentPlaylists
              playlists={recentPlaylists.list}
              openLink={playlistLink}
              onOpen={openPlaylist}
              onForget={recentPlaylists.forget}
            />
          </>
        )}

        {/* Where downloads go — visible before a video is opened, and used by Redownload too. */}
        <div className="w-full mt-4!">
          <SaveToSetting
            settings={saveTo.settings}
            onChoose={() => setChoosingFolder(true)}
            onClear={switchToBrowserDownloads}
          />
        </div>
        {choosingFolder && (
          <FolderPicker onChoose={chooseFolder} onClose={() => setChoosingFolder(false)} />
        )}
      </section>

      {/* Saves into the folder still running that the preview card doesn't show */}
      <ActiveSaves saves={saves} shownHref={selected ? selectedHref : undefined} />

      {/* Playlist panel: open while a playlist or album is loaded */}
      {playlistLink !== null && (
        <SpotifyPlaylistPanel
          source={playlistSource}
          playlist={playlist.data}
          isLoading={playlist.isLoading}
          isRefreshing={playlist.isFetching && !playlist.isLoading}
          error={playlist.error}
          activeTrackId={
            playlistSource === "youtube"
              ? (selected && extractVideoId(selected.url)) || undefined
              : isSearching
                ? pendingTrackId
                : (spotify?.id ?? selected?.spotifyId)
          }
          isSearching={isSearching}
          downloadedIds={downloadedIds}
          folder={
            saveTo.folder
              ? {
                  path: saveTo.folder,
                  songs: folderSongs.data,
                  isOutdated: folderSongs.isPlaceholderData,
                  isChecking: folderSongs.isFetching,
                  error: folderSongs.error,
                }
              : undefined
          }
          canChooseFolder={saveTo.settings?.canSaveToFolder === true}
          statuses={downloadAll.statuses}
          progress={downloadAll.progress}
          onDownloadAll={(songs) => void downloadAll.start(songs, format, playlistSource)}
          playableCount={playlistInFolder.length}
          onPlay={(shuffle) =>
            player.play(
              playlistInFolder,
              shuffle ? Math.floor(Math.random() * playlistInFolder.length) : 0,
              { shuffle },
            )
          }
          onQueue={() => {
            const playing = player.current !== null;
            player.enqueue(playlistInFolder, "last");
            if (playing && !player.upNextOpen) {
              toast({
                title: "Added to the queue",
                description: `${playlistInFolder.length} ${playlistInFolder.length === 1 ? "song" : "songs"} from “${playlist.data?.name ?? "the playlist"}”, at the end.`,
              });
            }
          }}
          onSavePlaylistFile={() => playlist.data && writePlaylistFile(playlist.data)}
          savingPlaylistFile={isSavingPlaylistFile}
          onStop={downloadAll.stop}
          onPick={pickPlaylistSong}
          onRefresh={() => void playlist.refetch()}
          onClose={() => setPlaylistLink(null)}
        />
      )}

      {/* Result Section */}
      <AnimatePresence mode="wait">
        {selected && (
          <motion.section
            key="preview"
            ref={previewRef}
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.23, 1, 0.32, 1] }}
            className="w-full max-w-3xl mx-auto scroll-mt-24"
          >
            <PreviewCard
              video={selected}
              fileName={fileName}
              onRename={setFileName}
              format={format}
              onFormatChange={setFormat}
              href={selectedHref}
              save={selectedSave}
              done={selectedDone}
              onDownload={handleDownload}
              onClear={clear}
            />
          </motion.section>
        )}

        {error && (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="max-w-2xl mx-auto w-full"
          >
            <div className="bg-destructive/10 text-destructive-foreground border border-destructive/20 rounded-2xl p-4 flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-destructive" />
              <p className="text-sm font-medium text-destructive">{error.message}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search results */}
      {(isSearching || results) && (
        <SearchResults
          isSearching={isSearching}
          results={results}
          spotify={spotify}
          searchedFor={searchedFor?.query}
          source={searchData?.source}
          soundCloudOnly={searchedFor?.soundCloudOnly}
          onSearchSoundCloud={
            searchedFor ? () => runSearch(searchedFor.query, pendingTrackId, true) : undefined
          }
          selectedUrl={selected?.url}
          previewing={previewing}
          onTogglePreview={togglePreview}
          onClosePreview={() => setPreviewing(null)}
          onPick={pick}
          onClose={resetSearch}
        />
      )}

      {/* The music player's songs: the Save to folder's, or ones on this device */}
      <MusicLibrary
        settings={saveTo.settings}
        folder={saveTo.folder}
        onChooseFolder={() => setChoosingFolder(true)}
        locate={locating}
      />

      <RecentExtractions
        history={allHistory}
        isLoading={isLoadingHistory}
        format={format}
        folder={saveTo.folder}
        saves={saves}
        onDownload={startDownload}
        onLocate={(id) => setLocating({ id })}
      />
    </Layout>
  );
}
