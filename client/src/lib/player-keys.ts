/**
 * The music player's keyboard shortcuts, as on YouTube: they work anywhere on
 * the page while a song is loaded, except while you type in a box or use a
 * dialog. Pure, so it can be tested without a page.
 */

export type PlayerKeyAction =
  | { kind: "toggle" }
  | { kind: "seekBy"; seconds: number }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "mute" }
  | { kind: "help" };

/** The shortcuts, for the help list and the buttons' tooltips. */
export const PLAYER_SHORTCUTS = [
  { keys: ["Space", "K"], what: "Play or pause" },
  { keys: ["←", "→"], what: "Back or forward 5 seconds" },
  { keys: ["J", "L"], what: "Back or forward 10 seconds" },
  { keys: ["Shift+P", "Shift+N"], what: "Previous or next song" },
  { keys: ["M"], what: "Mute or unmute" },
  { keys: ["?"], what: "These shortcuts" },
] as const;

/** A key press, as much of it as matters here. */
export type KeyPress = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

/** Where the key was pressed. */
export type KeyTarget = {
  /** A box you type in, or something the arrow keys move (a slider, a menu). */
  typing: boolean;
  /** A button or link: Space and Enter press it. */
  pressable: boolean;
  /** Inside a dialog: its keys are its own. */
  inDialog: boolean;
};

/** What a key press does to the player, if anything. */
export function playerKeyAction(press: KeyPress, target: KeyTarget): PlayerKeyAction | null {
  if (press.ctrlKey || press.altKey || press.metaKey) return null;
  if (target.typing || target.inDialog) return null;
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  // Shift+/ on most keyboards, but not all.
  if (key === "?") return { kind: "help" };
  if (press.shiftKey) {
    if (key === "n") return { kind: "next" };
    if (key === "p") return { kind: "previous" };
    return null;
  }
  switch (key) {
    case " ":
      return target.pressable ? null : { kind: "toggle" };
    case "k":
      return { kind: "toggle" };
    case "ArrowLeft":
      return { kind: "seekBy", seconds: -5 };
    case "ArrowRight":
      return { kind: "seekBy", seconds: 5 };
    case "j":
      return { kind: "seekBy", seconds: -10 };
    case "l":
      return { kind: "seekBy", seconds: 10 };
    case "m":
      return { kind: "mute" };
    default:
      return null;
  }
}

/** Where a key was pressed, from the element that had the focus. */
export function keyTargetOf(element: Element | null): KeyTarget {
  if (!element) return { typing: false, pressable: false, inDialog: false };
  const typing =
    element.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])") ||
    // Widgets that move with the arrow keys.
    element.closest(
      "[role=textbox], [role=combobox], [role=slider], [role=listbox], [role=menu], [role=menubar], [role=radiogroup], [role=tablist]",
    ) !== null;
  const pressable =
    element.closest(
      "button, a[href], summary, [role=button], [role=checkbox], [role=switch], [role=tab], [role=option], [role=menuitem], [role=radio]",
    ) !== null;
  const inDialog = element.closest("dialog, [role=dialog], [role=alertdialog]") !== null;
  return { typing, pressable, inDialog };
}
