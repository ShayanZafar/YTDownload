import { describe, expect, it, vi } from "vitest";
import { STOP_SIGNALS, onShutdown, runShutdown, stopCleanlyOnSignals } from "../../server/shutdown";

// Stopping the app cleanly (server/shutdown.ts): what's under way tidies up first.

describe("runShutdown", () => {
  it("runs every tidy-up still registered, at once, and only once", async () => {
    const order: string[] = [];
    onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
    });
    onShutdown(() => order.push("quick"));
    const forgotten = onShutdown(() => order.push("finished already"));
    forgotten();
    await runShutdown();
    expect(order).toEqual(["quick", "slow"]);
    await runShutdown();
    expect(order).toEqual(["quick", "slow"]);
  });

  it("doesn't wait past its grace for a tidy-up that hangs, nor fail for one that throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onShutdown(() => new Promise(() => {}));
    onShutdown(() => {
      throw new Error("couldn't");
    });
    const done = vi.fn();
    onShutdown(done);
    const started = Date.now();
    await runShutdown(100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(done).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("stopCleanlyOnSignals", () => {
  it("tidies up, then exits, on a stop signal; a second one exits at once", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const exit = vi.fn();
    const before = new Map(STOP_SIGNALS.map((s) => [s, process.listeners(s)]));
    stopCleanlyOnSignals(exit);
    let tidied = false;
    onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tidied = true;
    });
    try {
      process.emit("SIGINT");
      expect(exit).not.toHaveBeenCalled();
      process.emit("SIGTERM");
      expect(exit).toHaveBeenCalledWith(1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
      expect(tidied).toBe(true);
    } finally {
      for (const signal of STOP_SIGNALS) {
        for (const listener of process.listeners(signal)) {
          if (!before.get(signal)!.includes(listener)) process.removeListener(signal, listener);
        }
      }
      log.mockRestore();
    }
  });
});
