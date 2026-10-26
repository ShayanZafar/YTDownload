import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { matchChoices, type FacetChoice } from "@/lib/music";
import { cn } from "@/lib/utils";

/**
 * One of Your music's filters (genre, artist, album, year, details) as a
 * combobox: type a few letters and the choices narrow to the ones that have
 * them, each with how many songs it has; pick one with a click, or with the
 * arrow keys and Enter (Enter alone takes the first). The owner's ask: no
 * scrolling through a long list every time. Its first choice, while nothing
 * is typed, shows every song again.
 */
export function FacetFilter({
  label,
  name,
  all,
  choices,
  value,
  onChange,
}: {
  /** Its accessible name: "Show songs of genre". */
  label: string;
  /** What it filters by, for the box's tooltip: "Genre". */
  name: string;
  /** The choice that shows every song: "All genres". */
  all: string;
  choices: readonly FacetChoice[];
  /** The value chosen, or undefined for every song. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  const listId = `${id}-choices`;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  // The choice made, as the list names it (any spelling of it).
  const chosen =
    value === undefined
      ? undefined
      : choices.find((choice) => choice.value.toLocaleLowerCase() === value.toLocaleLowerCase());
  const shownText = chosen ? chosen.text.replace(/ \(\d[\d,.]*\)$/, "") : "";
  // What the list offers: every song first while nothing is typed, then the choices that match.
  const offered: { value: string | undefined; text: string }[] = [
    ...(typed.trim() ? [] : [{ value: undefined, text: all }]),
    ...matchChoices(choices, typed),
  ];

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const close = () => {
    setOpen(false);
    setTyped("");
  };
  const choose = (choice: { value: string | undefined } | undefined) => {
    if (choice) onChange(choice.value);
    close();
  };
  // Opening the list: on the choice made, or the first.
  const openList = () => {
    if (open) return;
    const at = offered.findIndex((choice) => choice.value === chosen?.value);
    setActive(Math.max(0, at));
    setOpen(true);
  };

  return (
    <div className="relative" title={name}>
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && offered[active] ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={open ? typed : shownText}
        placeholder={open ? shownText || all : all}
        onFocus={openList}
        onClick={openList}
        onBlur={close}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) return openList();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((at) => Math.min(Math.max(at + step, 0), offered.length - 1));
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            choose(offered[active]);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
        className={cn(
          "h-9 w-36 rounded-lg border bg-card pl-2 pr-7 text-xs font-medium text-foreground placeholder:text-foreground",
          open && "placeholder:text-muted-foreground",
          value !== undefined ? "border-primary" : "border-border",
        )}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
      />
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute left-0 top-full z-30 mt-1 max-h-72 w-64 max-w-[80vw] overflow-y-auto rounded-lg border border-border bg-card py-1 text-xs shadow-lg"
        >
          {offered.map((choice, index) => (
            <li
              key={choice.value ?? "*"}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={choice.value === chosen?.value}
              // Keeps the focus in the box, so the list stays open until the click picks it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(choice)}
              className={cn(
                "cursor-pointer break-words px-3 py-1.5 text-foreground",
                index === active && "bg-secondary",
                choice.value === chosen?.value && "font-semibold",
              )}
            >
              {choice.text}
            </li>
          ))}
          {offered.length === 0 && (
            <li role="presentation" className="px-3 py-1.5 text-muted-foreground">
              Nothing has “{typed.trim()}”.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
