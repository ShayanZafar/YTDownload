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
/** The list's width (`w-64 max-w-[80vw]`), in CSS pixels. */
const LIST_WIDTH = 256;
const listWidth = () => Math.min(LIST_WIDTH, window.innerWidth * 0.8);

/**
 * Whether the list should hang to the left of the box's right edge instead of
 * from its left edge: when it would reach past something that clips it — an
 * ancestor that hides its overflow (the card around Your music), or the window
 * — and there's room for it on the left.
 */
export function listGoesLeft(box: HTMLElement, width = listWidth()): boolean {
  const { left, right } = box.getBoundingClientRect();
  if (right - width < 0) return false;
  const end = left + width;
  if (end > window.innerWidth) return true;
  for (let el = box.parentElement; el; el = el.parentElement) {
    if (getComputedStyle(el).overflowX !== "visible" && end > el.getBoundingClientRect().right)
      return true;
  }
  return false;
}

/** Scrolls the list, and nothing else, just enough to show the item. */
export function scrollListTo(list: HTMLElement, item: HTMLElement): void {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

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
  // Whether the list hangs to the left of the box's right edge, when it would
  // stick out of the card (or the window) otherwise.
  const [toLeft, setToLeft] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Whether the list is open, for keys pressed faster than React shows it (WebKit):
  // an ArrowUp right after the ArrowDown that opened it moves, instead of opening it again.
  const isOpen = useRef(false);

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

  // Keeps the active choice in view by scrolling the list itself, and only it:
  // scrollIntoView() would also scroll whatever clips the list — the card around
  // Your music (overflow hidden), the page — and shove the whole list of songs aside.
  useEffect(() => {
    if (!open || !list.current) return;
    const item = list.current.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (item) scrollListTo(list.current, item);
  }, [open, active]);

  const close = () => {
    isOpen.current = false;
    setOpen(false);
    setTyped("");
  };
  const choose = (choice: { value: string | undefined } | undefined) => {
    if (choice) onChange(choice.value);
    close();
  };
  // Opening the list: on the choice made, or the first.
  const openList = () => {
    if (isOpen.current) return;
    const at = offered.findIndex((choice) => choice.value === chosen?.value);
    isOpen.current = true;
    setActive(Math.max(0, at));
    setToLeft(box.current ? listGoesLeft(box.current) : false);
    setOpen(true);
  };

  return (
    <div className="relative" title={name}>
      <input
        ref={box}
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
          isOpen.current = true;
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!isOpen.current) return openList();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((at) => Math.min(Math.max(at + step, 0), offered.length - 1));
          } else if (event.key === "Enter" && isOpen.current) {
            event.preventDefault();
            choose(offered[active]);
          } else if (event.key === "Escape" && isOpen.current) {
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
          className={cn(
            "absolute top-full z-30 mt-1 max-h-72 w-64 max-w-[80vw] overflow-y-auto rounded-lg border border-border bg-card py-1 text-xs shadow-lg",
            toLeft ? "right-0" : "left-0",
          )}
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
