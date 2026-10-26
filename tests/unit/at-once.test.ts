import { describe, expect, it } from "vitest";
import { eachAtOnce } from "../../client/src/lib/at-once";

describe("eachAtOnce", () => {
  it("says how many are done out of how many: none first, then after each", async () => {
    const heard: string[] = [];
    await eachAtOnce(
      ["a", "b", "c"],
      async () => {},
      2,
      undefined,
      (done, total) => heard.push(`${done}/${total}`),
    );
    expect(heard).toEqual(["0/3", "1/3", "2/3", "3/3"]);
  });

  it("stops saying so once stopped, and starts no more", async () => {
    const stop = new AbortController();
    const heard: number[] = [];
    const ran: number[] = [];
    await eachAtOnce(
      [1, 2, 3, 4, 5],
      async (n) => {
        ran.push(n);
        if (n === 2) stop.abort();
      },
      1,
      stop.signal,
      (done) => heard.push(done),
    );
    expect(ran).toEqual([1, 2]);
    expect(heard).toEqual([0, 1]);
  });

  it("does nothing for no items, saying 0 of 0", async () => {
    const heard: string[] = [];
    await eachAtOnce(
      [],
      async () => {},
      4,
      undefined,
      (done, total) => heard.push(`${done}/${total}`),
    );
    expect(heard).toEqual(["0/0"]);
  });
});
