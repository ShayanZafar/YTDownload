import { describe, expect, it } from "vitest";
import os from "os";
import { cpuCores, mapAtOnce } from "../../server/cpu-cores";

describe("cpuCores", () => {
  it("is this computer's: one per CPU core, at least one", () => {
    expect(cpuCores()).toBe(Math.max(1, os.availableParallelism()));
    expect(cpuCores()).toBeGreaterThanOrEqual(1);
  });
});

describe("mapAtOnce", () => {
  /** Runs `count` items through mapAtOnce, each taking a few ms, and says how many ran at once. */
  async function busiest(count: number, atOnce?: number) {
    let running = 0;
    let most = 0;
    const results = await mapAtOnce(
      Array.from({ length: count }, (_, i) => i),
      async (i) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 5 + (i % 3)));
        running--;
        return i * 2;
      },
      atOnce,
    );
    return { results, most };
  }

  it("keeps the items' order, whatever order they finish in", async () => {
    const { results } = await busiest(10, 3);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it("runs as many at once as it's told, starting the next as one finishes", async () => {
    expect((await busiest(10, 3)).most).toBe(3);
    expect((await busiest(2, 8)).most).toBe(2);
    expect((await busiest(4, 0)).most).toBe(1);
  });

  it("runs one per CPU core unless told otherwise", async () => {
    const count = cpuCores() + 2;
    expect((await busiest(count)).most).toBe(cpuCores());
  });

  it("does nothing for no items", async () => {
    expect(await mapAtOnce([], async () => 1)).toEqual([]);
  });
});
