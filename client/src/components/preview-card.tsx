import { CheckCircle2, Cloud, Download, Loader2, Music } from "lucide-react";
import type { DownloadFormat } from "@shared/routes";
import { sanitizedFileName } from "@shared/name-noise";
import type { AudioSource } from "@shared/schema";
import { fileNameOf, songOfVideo } from "@shared/song-name";
import { RenameableTitle } from "@/components/renameable-title";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatDuration } from "@/lib/format";
import { folderName, type ActiveSave } from "@/lib/save-to-folder";

// What the preview card shows: a video opened from a link or picked from the
// search results (a SoundCloud track, when YouTube couldn't answer the search).
export type Selected = {
  url: string;
  title: string;
  thumbnail: string;
  channel?: string;
  duration?: number | null;
  /** The Spotify song it was found for, kept with the download in the history. */
  spotifyId?: string;
  /**
   * The name to save it under unless renamed: "Artist - Title" for a Spotify
   * song (rather than the YouTube video's title).
   */
  fileTitle?: string;
  /** Where it is: YouTube when left out. */
  source?: AudioSource;
};

type PreviewCardProps = {
  video: Selected;
  /** The name to save its audio under; null = its title. */
  fileName: string | null;
  onRename: (name: string | null) => void;
  format: DownloadFormat;
  onFormatChange: (format: DownloadFormat) => void;
  /** Its download link (with the name and format). */
  href: string;
  /** Its save into the "Save to" folder, while one runs. */
  save?: ActiveSave;
  /** Downloaded already (it's in the history): the button says so, and downloads it again. */
  done?: boolean;
  onDownload: (event: React.MouseEvent) => void;
  onClear: () => void;
};

/**
 * The name the server saves it as unless it's renamed: a Spotify song's
 * "Artist - Title", or the artist and title the video's title and channel say
 * ("Artist - Title": shared/song-name.ts).
 */
export const defaultNameOf = (video: Pick<Selected, "title" | "channel" | "fileTitle">) =>
  video.fileTitle
    ? sanitizedFileName(video.fileTitle)
    : fileNameOf(songOfVideo(video.title, video.channel));

/**
 * The chosen video, ready to download: its thumbnail, its title (click it to
 * rename the file), Download Audio (or a save's progress), the Original audio
 * switch and Clear and start over.
 */
export function PreviewCard({
  video,
  fileName,
  onRename,
  format,
  onFormatChange,
  href,
  save,
  done = false,
  onDownload,
  onClear,
}: PreviewCardProps) {
  const isOriginal = format === "original";
  const fromSoundCloud = video.source === "soundcloud";
  const from = fromSoundCloud ? "SoundCloud" : "YouTube";
  return (
    <div className="glass-card rounded-4xl p-4 md:p-6 flex flex-col md:flex-row gap-6 items-center">
      {/* Thumbnail */}
      <div className="w-full md:w-1/2 aspect-video relative rounded-2xl overflow-hidden shadow-md group bg-secondary">
        {/* A SoundCloud track may have no artwork: then just the background. */}
        {video.thumbnail && (
          <img
            src={video.thumbnail}
            alt={video.title}
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        )}
        <div className="absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        <div className="absolute bottom-3 left-3 bg-black/70 backdrop-blur-md text-white text-xs font-semibold px-2.5 py-1 rounded-md flex items-center gap-1.5">
          <Music className="w-3 h-3" /> Audio Track
        </div>
      </div>

      {/* Info & Action */}
      <div className="flex-1 flex flex-col items-center text-center md:items-start md:text-left gap-4 w-full">
        <div className="w-full md:w-auto">
          <RenameableTitle
            key={video.url}
            defaultName={defaultNameOf(video)}
            fileName={fileName}
            extension={isOriginal ? ".opus" : ".mp3"}
            extensionHint={
              isOriginal
                ? fromSoundCloud
                  ? "SoundCloud's own stream: .opus or .mp3, whichever it has for this track"
                  : "Usually .opus — .m4a when YouTube only has AAC audio for this video"
                : undefined
            }
            onRename={onRename}
          />
          {(video.channel || fromSoundCloud) && (
            <p className="mt-1 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm text-muted-foreground md:justify-start">
              {video.channel && (
                <span>
                  {video.channel}
                  {video.duration != null && ` · ${formatDuration(video.duration)}`}
                </span>
              )}
              {fromSoundCloud && (
                <span
                  title="On SoundCloud: YouTube couldn't answer the search"
                  className="inline-flex shrink-0 items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-foreground"
                >
                  <Cloud className="w-3 h-3" />
                  SoundCloud
                </span>
              )}
            </p>
          )}
        </div>

        <p className="text-sm text-muted-foreground line-clamp-1">
          {isOriginal
            ? "Ready to download the original audio."
            : "Ready to download as a 320 kbps MP3."}
        </p>

        <div className="mt-2 w-full">
          {save ? (
            <div className="flex gap-2">
              <div
                role="status"
                className="flex-1 min-w-0 flex items-center justify-center gap-2 h-14 px-3 rounded-xl bg-foreground/90 text-background font-semibold"
              >
                <Loader2 className="w-5 h-5 shrink-0 animate-spin" />
                <span className="truncate">
                  Saving
                  <span className="hidden sm:inline"> to {folderName(save.folder)}</span>
                </span>
                <span className="shrink-0 font-normal opacity-70 tabular-nums">
                  {save.bytes > 0 ? formatBytes(save.bytes) : "starting…"}
                </span>
              </div>
              <button
                type="button"
                onClick={save.cancel}
                className="h-14 px-4 rounded-xl border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <a
              href={href}
              download
              onClick={onDownload}
              className="w-full flex items-center justify-center gap-2 h-14 rounded-xl bg-foreground text-background font-semibold hover-elevate active-elevate-2 transition-all shadow-xl shadow-foreground/20"
            >
              {done ? (
                <>
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  Download Complete
                  <span className="font-normal opacity-60 truncate">· Download audio again</span>
                </>
              ) : (
                <>
                  <Download className="w-5 h-5" />
                  Download Audio
                  <span className="font-normal opacity-60">
                    · {isOriginal ? "Original" : "MP3"}
                  </span>
                </>
              )}
            </a>
          )}

          <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-border px-4 py-3 text-left">
            <div>
              <Label
                htmlFor="original-audio"
                className="text-sm font-medium text-foreground cursor-pointer"
              >
                Original audio
              </Label>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                {`${from}'s own stream, not converted (${fromSoundCloud ? ".mp3 or .opus" : "usually .opus"}).`}{" "}
                Smaller and untouched; plays in VLC, but not on some phones and car stereos.
              </p>
            </div>
            <Switch
              id="original-audio"
              checked={isOriginal}
              onCheckedChange={(on) => onFormatChange(on ? "original" : "mp3")}
              className="mt-0.5"
            />
          </div>

          <button
            onClick={onClear}
            className="w-full mt-3 text-sm text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            Clear and start over
          </button>
        </div>
      </div>
    </div>
  );
}
