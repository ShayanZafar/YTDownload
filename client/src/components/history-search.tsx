import { useId, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/format";
import { highlightParts, historySuggestions, type HistorySuggestion } from "@/lib/history-filter";
import type { Download } from "@shared/schema";

/** `text` with the words of `query` marked, e.g. the typed words in a matching title. */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {highlightParts(text, query).map((part, i) =>
        part.match ? (
          <mark key={i} className="rounded-sm bg-primary/10 font-semibold text-foreground">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

type HistorySearchProps = {
  /** The history to suggest from (already narrowed to the chosen date range). */
  entries: readonly Download[];
  value: string;
  /** True once a suggestion was picked: the list then shows that exact song. */
  exact: boolean;
  /** Typing: the list narrows to entries containing every word typed. */
  onChange: (value: string) => void;
  /** Picking a suggestion: the list shows exactly that song. */
  onPick: (title: string) => void;
};

/**
 * The history search box, with autocomplete: as you type, matching songs drop
 * down below (each once, best match first). Arrow keys and Enter, or a click,
 * pick one; Escape closes the list. Follows the ARIA combobox pattern so
 * screen readers announce the suggestions.
 */
export function HistorySearch({ entries, value, exact, onChange, onPick }: HistorySearchProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = useMemo(
    () => (exact ? [] : historySuggestions(entries, value)),
    [entries, value, exact],
  );
  const showList = open && suggestions.length > 0;

  const pick = (suggestion: HistorySuggestion) => {
    onPick(suggestion.title);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const count = suggestions.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return;
      event.preventDefault();
      setOpen(true);
      setActive((i) => (event.key === "ArrowDown" ? (i + 1) % count : i <= 0 ? count - 1 : i - 1));
    } else if (event.key === "Enter") {
      if (showList && active >= 0) {
        event.preventDefault();
        pick(suggestions[active]);
      } else {
        setOpen(false);
      }
    } else if (event.key === "Escape" && showList) {
      event.preventDefault(); // close the list; a second Escape clears the box
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label="Search your extractions"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder="Search your extractions"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        className="w-full h-10 rounded-xl border border-border bg-card pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-primary/15 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          title="Clear search"
          onMouseDown={(event) => event.preventDefault()} // keep focus in the box
          onClick={() => {
            onChange("");
            setOpen(false);
            inputRef.current?.focus();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      )}
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching extractions"
          className="absolute z-20 mt-1 w-full max-h-80 overflow-auto rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          {suggestions.map((suggestion, i) => (
            <li
              key={suggestion.title}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: picking must happen before the box loses focus.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(suggestion);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm",
                i === active && "bg-secondary",
              )}
            >
              <span className="min-w-0 truncate text-foreground">
                <Highlight text={suggestion.title} query={value} />
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {suggestion.count > 1 && `${suggestion.count}× · `}
                {timeAgo(suggestion.lastDownloadedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
