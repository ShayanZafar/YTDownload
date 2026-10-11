import { useEffect } from "react";
import { usePlayer } from "@/hooks/use-player";
import { useToast } from "@/hooks/use-toast";
import { PLAYER_SHORTCUTS, keyTargetOf, playerKeyAction } from "@/lib/player-keys";

/** The shortcuts, as a list for a note. */
function ShortcutList() {
  return (
    <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {PLAYER_SHORTCUTS.map(({ keys, what }) => (
        <div key={what} className="contents">
          <dt className="flex gap-1">
            {keys.map((key) => (
              <kbd
                key={key}
                className="rounded border border-border bg-secondary px-1.5 font-mono text-[11px]"
              >
                {key}
              </kbd>
            ))}
          </dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The player's keyboard shortcuts (`PLAYER_SHORTCUTS`), anywhere on the page
 * while a song is loaded; ? lists them.
 */
export function usePlayerShortcuts() {
  const player = usePlayer();
  const { toast } = useToast();
  const loaded = player.current !== null;
  const { toggle, seekBy, next, previous, toggleMute } = player;

  useEffect(() => {
    if (!loaded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      const action = playerKeyAction(event, keyTargetOf(target));
      if (!action) return;
      // Space would scroll the page, and the arrows too.
      event.preventDefault();
      if (event.repeat && action.kind !== "seekBy") return;
      if (action.kind === "toggle") toggle();
      else if (action.kind === "seekBy") seekBy(action.seconds);
      else if (action.kind === "next") next();
      else if (action.kind === "previous") previous();
      else if (action.kind === "mute") toggleMute();
      else toast({ title: "Keyboard shortcuts", description: <ShortcutList /> });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [loaded, toggle, seekBy, next, previous, toggleMute, toast]);
}
