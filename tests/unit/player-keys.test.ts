import { describe, expect, it } from "vitest";
import {
  PLAYER_SHORTCUTS,
  playerKeyAction,
  type KeyPress,
  type KeyTarget,
} from "../../client/src/lib/player-keys";

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});
const page: KeyTarget = { typing: false, pressable: false, inDialog: false };

describe("the player's keyboard shortcuts", () => {
  it("play, pause, seek, skip and mute, as on YouTube", () => {
    expect(playerKeyAction(press(" "), page)).toEqual({ kind: "toggle" });
    expect(playerKeyAction(press("k"), page)).toEqual({ kind: "toggle" });
    expect(playerKeyAction(press("K"), page)).toEqual({ kind: "toggle" }); // Caps Lock
    expect(playerKeyAction(press("ArrowLeft"), page)).toEqual({ kind: "seekBy", seconds: -5 });
    expect(playerKeyAction(press("ArrowRight"), page)).toEqual({ kind: "seekBy", seconds: 5 });
    expect(playerKeyAction(press("j"), page)).toEqual({ kind: "seekBy", seconds: -10 });
    expect(playerKeyAction(press("l"), page)).toEqual({ kind: "seekBy", seconds: 10 });
    expect(playerKeyAction(press("N", { shiftKey: true }), page)).toEqual({ kind: "next" });
    expect(playerKeyAction(press("P", { shiftKey: true }), page)).toEqual({ kind: "previous" });
    expect(playerKeyAction(press("m"), page)).toEqual({ kind: "mute" });
    expect(playerKeyAction(press("?", { shiftKey: true }), page)).toEqual({ kind: "help" });
  });

  it("leave other keys alone", () => {
    for (const key of ["a", "n", "p", "Enter", "ArrowUp", "Tab", "Escape"]) {
      expect(playerKeyAction(press(key), page)).toBeNull();
    }
    expect(playerKeyAction(press("K", { shiftKey: true }), page)).toBeNull();
  });

  it("leave the browser's own shortcuts alone (Ctrl+L, Alt+←, ⌘K…)", () => {
    expect(playerKeyAction(press("l", { ctrlKey: true }), page)).toBeNull();
    expect(playerKeyAction(press("ArrowLeft", { altKey: true }), page)).toBeNull();
    expect(playerKeyAction(press("k", { metaKey: true }), page)).toBeNull();
  });

  it("stay out of the way while typing or in a dialog", () => {
    const typing = { ...page, typing: true };
    const dialog = { ...page, inDialog: true };
    for (const key of [" ", "k", "j", "m", "ArrowLeft"]) {
      expect(playerKeyAction(press(key), typing)).toBeNull();
      expect(playerKeyAction(press(key), dialog)).toBeNull();
    }
    expect(playerKeyAction(press("N", { shiftKey: true }), typing)).toBeNull();
  });

  it("let Space press a focused button, but still take the letter keys there", () => {
    const button = { ...page, pressable: true };
    expect(playerKeyAction(press(" "), button)).toBeNull();
    expect(playerKeyAction(press("k"), button)).toEqual({ kind: "toggle" });
    expect(playerKeyAction(press("ArrowRight"), button)).toEqual({ kind: "seekBy", seconds: 5 });
  });

  it("are all listed for the help", () => {
    const listed = PLAYER_SHORTCUTS.flatMap((shortcut) => shortcut.keys);
    expect(listed).toEqual(["Space", "K", "←", "→", "J", "L", "Shift+P", "Shift+N", "M", "?"]);
  });
});
