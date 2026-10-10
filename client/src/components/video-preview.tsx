import { useEffect, useRef } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { youtubeEmbedUrl } from "@shared/youtube-link";

/**
 * A search result's video, played in YouTube's own embedded player right in the
 * results list, to watch or listen to before choosing it. It starts playing as
 * it opens (it's opened by a click); closing it removes the player, which stops
 * the video.
 */
export function VideoPreview({
  videoId,
  title,
  url,
  isPicked,
  onChoose,
  onClose,
}: {
  videoId: string;
  title: string;
  url: string;
  isPicked: boolean;
  onChoose: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Bring the player into view: a result low on the screen opens below it.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [videoId]);

  const src = youtubeEmbedUrl(videoId);
  if (!src) return null;
  return (
    <div ref={ref} className="px-4 pb-4 space-y-2">
      <div className="relative w-full aspect-video overflow-hidden rounded-xl bg-black">
        <iframe
          src={src}
          title={`Preview: ${title}`}
          className="absolute inset-0 w-full h-full"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          // YouTube's player refuses to play without knowing which site embeds it.
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {isPicked ? (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
            <Check className="w-4 h-4" />
            Selected — download it above
          </span>
        ) : (
          <button
            type="button"
            onClick={onChoose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            Choose this one
          </button>
        )}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          Open on YouTube
        </a>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary/60 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          Close preview
        </button>
      </div>
    </div>
  );
}
