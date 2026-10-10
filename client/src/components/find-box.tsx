import { useState, type RefObject } from "react";
import { ArrowRight, ClipboardPaste, Link2, ListMusic, Loader2, Search, X } from "lucide-react";
import type { CopiedLink } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// Paste a link, search by song title, or open a Spotify or YouTube playlist to
// pick songs from. The last one used is remembered.
export const inputModes = ["link", "search", "playlist"] as const;
export type InputMode = (typeof inputModes)[number];

const modeOptions = [
  { mode: "link", label: "Paste a link", short: "Link", Icon: Link2 },
  { mode: "search", label: "Search by song", short: "Search", Icon: Search },
  { mode: "playlist", label: "Playlist", short: "Playlist", Icon: ListMusic },
] as const;

// The main box, for each mode.
const inputFor = {
  link: {
    type: "url",
    label: "YouTube link",
    placeholder: "https://www.youtube.com/watch?v=...",
    enterKeyHint: "go",
    Icon: Link2,
  },
  search: {
    type: "search",
    label: "Song search",
    placeholder: "Artist and song, or a Spotify song link",
    enterKeyHint: "search",
    Icon: Search,
  },
  playlist: {
    type: "url",
    label: "Playlist link",
    placeholder: "A Spotify playlist or album, or a YouTube playlist",
    enterKeyHint: "go",
    Icon: ListMusic,
  },
} as const;

type FindBoxProps = {
  /** The Link / Search / Playlist switch: what the box is labelled for. */
  mode: InputMode;
  onModeChange: (mode: InputMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  /** The box's text, trimmed and not empty: Enter, or the button next to it. */
  onSubmit: (value: string) => void;
  /** Opening a video, searching or opening a short link. */
  isBusy: boolean;
  isSearching: boolean;
  /** The page may read the clipboard: show the Paste button. */
  canPaste: boolean;
  onPaste: () => void;
  /** The page may look at the clipboard unasked, so the box is a combobox. */
  canSuggest: boolean;
  /** A link you've copied, suggested under the empty box. */
  suggestion: CopiedLink | null;
  onOpenSuggestion: (url: string) => void;
  onDismissSuggestion: (key: string) => void;
  /** The empty box got the focus: a time to look at the clipboard. */
  onFocusEmpty: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
};

/**
 * The Link / Search / Playlist switch and the main box under it, with the
 * Paste button and a link you've copied suggested under the empty box.
 */
export function FindBox({
  mode,
  onModeChange,
  text,
  onTextChange,
  onSubmit,
  isBusy,
  isSearching,
  canPaste,
  onPaste,
  canSuggest,
  suggestion,
  onOpenSuggestion,
  onDismissSuggestion,
  onFocusEmpty,
  inputRef,
}: FindBoxProps) {
  const [isBoxFocused, setBoxFocused] = useState(false);
  const input = inputFor[mode];

  const switchMode = (next: InputMode) => {
    onModeChange(next);
    inputRef.current?.focus();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const value = text.trim();
    if (value) onSubmit(value);
  };

  // The copied link suggested under the empty box: Enter opens it, Esc dismisses it.
  const onBoxKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestion || e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onOpenSuggestion(suggestion.url);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDismissSuggestion(suggestion.key);
    }
  };

  return (
    <>
      {/* Link / Search / Playlist switch (short labels on a phone) */}
      <div
        role="group"
        aria-label="Find audio by"
        className="mt-8 inline-flex rounded-full border border-border bg-secondary/60 p-1"
      >
        {modeOptions.map(({ mode: value, label, short, Icon }) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            aria-label={label}
            onClick={() => switchMode(value)}
            className={cn(
              "inline-flex items-center gap-1.5 sm:gap-2 rounded-full px-3 sm:px-4 py-2 text-sm font-medium transition-colors",
              mode === value
                ? "bg-card text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="w-4 h-4" />
            <span className="sm:hidden">{short}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Input Form */}
      <form onSubmit={handleSubmit} noValidate className="w-full relative mt-4 group">
        <div className="absolute inset-0 bg-primary/5 blur-2xl rounded-3xl transition-opacity duration-500 opacity-0 group-hover:opacity-100" />
        <div className="relative flex items-center w-full bg-card rounded-2xl shadow-lg shadow-black/5 border border-border focus-within:ring-4 focus-within:ring-primary/10 transition-all duration-300 p-2">
          <input.Icon className="w-5 h-5 sm:w-6 sm:h-6 shrink-0 text-muted-foreground ml-3 sm:ml-4 mr-1 sm:mr-2" />
          <input
            ref={inputRef}
            type={input.type}
            aria-label={input.label}
            // Where a copied link can be suggested, the box is a combobox: the
            // link is its one option, picked with Enter (or a click).
            role={canSuggest ? "combobox" : undefined}
            aria-autocomplete={canSuggest ? "list" : undefined}
            aria-expanded={canSuggest ? suggestion !== null : undefined}
            aria-controls={suggestion ? "copied-link-list" : undefined}
            aria-activedescendant={suggestion ? "copied-link" : undefined}
            aria-describedby={suggestion ? "copied-link-keys" : undefined}
            placeholder={input.placeholder}
            enterKeyHint={input.enterKeyHint}
            className="flex-1 w-0 min-w-0 bg-transparent border-none text-foreground placeholder:text-muted-foreground h-14 px-2 text-base sm:text-lg focus:outline-hidden"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onBoxKeyDown}
            onFocus={() => {
              setBoxFocused(true);
              if (!text.trim()) onFocusEmpty();
            }}
            onBlur={() => setBoxFocused(false)}
          />
          {canPaste && (
            <button
              type="button"
              onClick={onPaste}
              disabled={isBusy}
              aria-label="Paste from the clipboard"
              title="Paste from the clipboard"
              className="h-14 shrink-0 mr-1 sm:mr-2 px-3 sm:px-4 rounded-xl font-medium text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ClipboardPaste className="w-5 h-5" />
              <span className="hidden md:inline">Paste</span>
            </button>
          )}
          <button
            type="submit"
            disabled={isBusy || !text.trim()}
            aria-label={
              mode === "link" ? "Extract" : mode === "search" ? "Search" : "Open playlist"
            }
            className="h-14 shrink-0 px-4 sm:px-6 md:px-8 rounded-xl bg-primary text-primary-foreground font-semibold flex items-center gap-2 hover-elevate disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 transition-all"
          >
            {isBusy ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="hidden sm:inline">
                  {isSearching ? "Searching..." : "Processing..."}
                </span>
              </>
            ) : mode === "link" ? (
              <>
                <span className="hidden sm:inline">Extract</span>
                <ArrowRight className="w-5 h-5" />
              </>
            ) : mode === "playlist" ? (
              <>
                <span className="hidden sm:inline">Open</span>
                <ArrowRight className="w-5 h-5" />
              </>
            ) : (
              <>
                <span className="hidden sm:inline">Search</span>
                <Search className="w-5 h-5" />
              </>
            )}
          </button>
        </div>
        {/* A link you've copied, suggested under the empty box (Chrome and Edge, once allowed). */}
        {suggestion && (
          <div className="relative mt-2 flex items-stretch rounded-xl border border-border bg-card text-sm shadow-lg shadow-black/5">
            <ul
              id="copied-link-list"
              role="listbox"
              aria-label="Link you copied"
              className="flex min-w-0 flex-1"
            >
              <li
                id="copied-link"
                role="option"
                aria-selected
                aria-label={`Link you copied: ${suggestion.label}`}
                title={suggestion.url}
                // Clicking it leaves the focus where it is.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onOpenSuggestion(suggestion.url)}
                // Its icon and text line up with the box's.
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-3.5 rounded-l-xl py-2.5 pl-[22px] pr-3 text-left transition-colors hover:bg-secondary sm:gap-5 sm:pl-7 sm:pr-4",
                  isBoxFocused && "bg-secondary",
                )}
              >
                <ClipboardPaste className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-foreground/70">Link you copied</span>
                  <span className="min-w-0 truncate font-medium text-foreground">
                    {suggestion.label}
                  </span>
                </span>
                {isBoxFocused && (
                  <kbd
                    aria-hidden
                    className="ml-auto hidden shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-sans text-[11px] font-medium text-muted-foreground sm:inline"
                  >
                    Enter
                  </kbd>
                )}
              </li>
            </ul>
            <button
              type="button"
              aria-label="Dismiss the link you copied"
              title="Dismiss"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                // From the keyboard, the focus goes back to the box as this goes away.
                const hadFocus = document.activeElement === e.currentTarget;
                onDismissSuggestion(suggestion.key);
                if (hadFocus) inputRef.current?.focus();
              }}
              className="shrink-0 rounded-r-xl border-l border-border px-3 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
            <span id="copied-link-keys" className="sr-only">
              Press Enter to open it, or Escape to dismiss it.
            </span>
          </div>
        )}
      </form>
    </>
  );
}
