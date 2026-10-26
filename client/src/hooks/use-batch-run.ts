import { useEffect, useRef } from "react";

/**
 * A panel's runs over many songs (eachAtOnce), with a Stop button: `start()`
 * begins a run and gives its signal, `stop()` aborts the run going on, and so
 * does closing the panel.
 */
export function useBatchRun() {
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return {
    start(): AbortSignal {
      const abort = new AbortController();
      controller.current = abort;
      return abort.signal;
    },
    stop() {
      controller.current?.abort();
    },
  };
}
