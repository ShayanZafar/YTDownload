import { describe, expect, it } from "vitest";
import {
  checkCoreFlows,
  declaresTest,
  isUnder,
  tableCells,
  vitestPaths,
  type CheckOptions,
} from "../../scripts/core-flows-rules";

/**
 * scripts/core-flows.ts (`npm run core-flows`, part of `npm run verify`) fails the check when
 * docs/core-flows.md and the tests drift apart. These tests pin each way it can fail, so a flow
 * can't quietly lose a test or the gap count go back up.
 */

const FILES: Record<string, string> = {
  "tests/unit/a.test.ts": [
    'describe("a", () => {',
    '  it("adds one", () => {});',
    '  it("doesn\'t add two", async () => {});',
    "});",
  ].join("\n"),
  "tests/api/b.e2e.test.ts": 'it("serves it through the route", async () => {});',
  "tests/api/live.e2e.test.ts": 'it("asks YouTube for real", async () => {});',
  "tests/browser/c.spec.ts": [
    'test.describe("page", () => {',
    '  test("shows it in the browser", async ({ page }) => {',
    "  });",
    '  test("plays it from YouTube for real", { tag: "@live" }, async ({ page }) => {',
    "  });",
    "  test(",
    '    "opens the real Spotify",',
    '    { tag: ["@slow", "@live"] },',
    "    async ({ page }) => {",
    '      await page.goto("/?tag=@live");',
    "    },",
    "  );",
    '  test("mentions @live only in its body", async ({ page }) => {',
    '    await page.goto("/?tag=@live");',
    "  });",
    "});",
  ].join("\n"),
};

const options: CheckOptions = {
  readFile: (file) => FILES[file],
  runsInVerify: (file) => isUnder(file, ["tests/unit", "tests/api/b.e2e.test.ts"]),
};

const UNIT = "`tests/unit/a.test.ts` › adds one";
const UNIT_2 = "`tests/unit/a.test.ts` › doesn't add two";
const INTEGRATION = "`tests/api/b.e2e.test.ts` › serves it through the route";
const UI = "`tests/browser/c.spec.ts` › shows it in the browser";

function doc(rows: string[][], gapsAllowed: number | null = 1): string {
  return [
    "# Core flows",
    "",
    "What a person relies on the app for.",
    "",
    ...(gapsAllowed === null ? [] : [`Gaps allowed: ${gapsAllowed}`, ""]),
    "| Flow | Unit | Integration | UI |",
    "|---|---|---|---|",
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    "",
  ].join("\n");
}

const GOOD = doc([
  ["Do the thing", `${UNIT}<br>${UNIT_2}`, INTEGRATION, UI],
  ["Do the other thing", UNIT, "—", UI],
]);

describe("checkCoreFlows", () => {
  it("passes a file whose flows name existing tests, counting flows, tests and gaps", () => {
    expect(checkCoreFlows(GOOD, options)).toEqual({
      problems: [],
      flows: 2,
      tests: 4,
      gaps: 1,
      gapsAllowed: 1,
    });
  });

  it("reads a table Prettier has padded, with Windows line endings", () => {
    const padded = GOOD.replace("|---|---|---|---|", "| --- | ----- | ----------- | -- |")
      .replace(/ \| /g, "   |   ")
      .replace(/\n/g, "\r\n");
    expect(checkCoreFlows(padded, options).problems).toEqual([]);
  });

  it("fails without a Gaps allowed line", () => {
    const report = checkCoreFlows(doc([["Do the thing", UNIT, INTEGRATION, UI]], null), options);
    expect(report.problems).toEqual(['There is no "Gaps allowed: N" line.']);
  });

  it("fails without the flows table, or with a table that lists none", () => {
    expect(checkCoreFlows("# Core flows\n\nGaps allowed: 0\n", options).problems).toEqual([
      "There is no table headed | Flow | Unit | Integration | UI |.",
    ]);
    expect(checkCoreFlows(doc([], 0), options).problems).toEqual(["The table lists no flows."]);
  });

  it("fails on an empty cell, a missing cell or a reference it can't read", () => {
    const report = checkCoreFlows(
      doc(
        [
          ["Empty", UNIT, "", UI],
          ["Short", UNIT, INTEGRATION],
          ["Hyphen for a gap", UNIT, "-", UI],
          ["No backticks", UNIT, "tests/api/b.e2e.test.ts › serves it through the route", UI],
        ],
        0,
      ),
      options,
    );
    expect(report.problems).toEqual([
      '"Empty", Integration: the cell is empty; name a test, or write — for a gap.',
      '"Short": has 3 cells, not 4.',
      '"Hyphen for a gap", Integration: "-" isn\'t `file` › test title (or —, alone, for a gap).',
      expect.stringMatching(/^"No backticks", Integration: "tests\/api.* isn't `file` › test/),
    ]);
  });

  it("fails when a named test's file is gone, or no longer declares that title", () => {
    const report = checkCoreFlows(
      doc(
        [
          [
            "Do the thing",
            "`tests/unit/gone.test.ts` › adds one",
            "`tests/api/b.e2e.test.ts` › serves it through the router",
            UI,
          ],
        ],
        0,
      ),
      options,
    );
    expect(report.problems).toEqual([
      '"Do the thing", Unit: tests/unit/gone.test.ts doesn\'t exist.',
      '"Do the thing", Integration: tests/api/b.e2e.test.ts has no test titled "serves it through the router".',
    ]);
  });

  it("fails on a UI test that isn't a browser spec, or a unit or integration test verify doesn't run", () => {
    const report = checkCoreFlows(
      doc(
        [["Do the thing", UNIT, "`tests/api/live.e2e.test.ts` › asks YouTube for real", UNIT]],
        0,
      ),
      options,
    );
    expect(report.problems).toEqual([
      '"Do the thing", Integration: npm run verify doesn\'t run tests/api/live.e2e.test.ts: unit and integration tests must run on every change, without the network.',
      '"Do the thing", UI: tests/unit/a.test.ts isn\'t a browser test (tests/browser/*.spec.ts).',
    ]);
  });

  it("fails on a UI test tagged @live: it uses the real services, so pull requests don't run it", () => {
    const report = checkCoreFlows(
      doc(
        [
          [
            "Do the thing",
            UNIT,
            INTEGRATION,
            [
              "`tests/browser/c.spec.ts` › plays it from YouTube for real",
              "`tests/browser/c.spec.ts` › opens the real Spotify",
              "`tests/browser/c.spec.ts` › mentions @live only in its body",
            ].join("<br>"),
          ],
        ],
        0,
      ),
      options,
    );
    const why =
      "is tagged @live: it uses the real YouTube, Spotify or SoundCloud, so pull requests don't run it. Name a test that uses stand-ins.";
    expect(report.problems).toEqual([
      `"Do the thing", UI: tests/browser/c.spec.ts › plays it from YouTube for real ${why}`,
      `"Do the thing", UI: tests/browser/c.spec.ts › opens the real Spotify ${why}`,
    ]);
  });

  it("asks for the gap count to come down when a gap is closed", () => {
    const report = checkCoreFlows(GOOD.replace("Gaps allowed: 1", "Gaps allowed: 3"), options);
    expect(report.problems).toEqual([
      "1 gaps, fewer than allowed (3): close the gap count: set Gaps allowed: 1.",
    ]);
  });

  it("fails when a flow loses a test, so the gaps go up", () => {
    const report = checkCoreFlows(GOOD.replace(`| ${INTEGRATION} |`, "| — |"), options);
    expect(report.gaps).toBe(2);
    expect(report.problems).toEqual([
      "2 gaps, more than allowed (1): a core flow lost a test. Name one for each new gap; gaps only ever go down.",
    ]);
  });
});

describe("declaresTest", () => {
  it("finds the title as the first argument of it, test, describe and their variants", () => {
    expect(declaresTest('  it("adds one", () => {', "adds one")).toBe(true);
    expect(declaresTest("test('adds one', async () => {", "adds one")).toBe(true);
    expect(declaresTest('test.describe("Paste", () => {', "Paste")).toBe(true);
    expect(declaresTest("it.skip(`adds one`, () => {", "adds one")).toBe(true);
    expect(declaresTest('it.each(["a", "b"])("adds one", (x) => {', "adds one")).toBe(true);
    expect(declaresTest('it("says \\"hi\\"", () => {', 'says "hi"')).toBe(true);
  });

  it("finds a title Prettier has put on the line after the call", () => {
    expect(declaresTest('test(\n  "plays it",\n  { tag: "@live" },\n', "plays it")).toBe(true);
    expect(declaresTest('test(\r\n    "plays it",', "plays it")).toBe(true);
  });

  it("doesn't take part of a title, another argument or a string elsewhere for it", () => {
    expect(declaresTest('it("adds one more", () => {', "adds one")).toBe(false);
    expect(declaresTest('it("a track\'s save stops", () => {', "save stops")).toBe(false);
    expect(declaresTest('expect(sum("adds one")).toBe(1);', "adds one")).toBe(false);
    expect(declaresTest('const title = "adds one";', "adds one")).toBe(false);
  });
});

describe("tableCells", () => {
  it("splits a row into trimmed cells without the outer pipes", () => {
    expect(tableCells("|  Flow | Unit  |  — |")).toEqual(["Flow", "Unit", "—"]);
  });
});

describe("vitestPaths", () => {
  it("lists the files and folders the verify script's vitest run is given", () => {
    const verify =
      "prettier --check . && eslint . && tsc && npm run licenses && npm run core-flows && " +
      "vitest run tests/unit tests/api/music.e2e.test.ts --reporter=dot";
    expect(vitestPaths(verify)).toEqual(["tests/unit", "tests/api/music.e2e.test.ts"]);
    expect(vitestPaths("eslint .")).toEqual([]);
  });

  it("counts a file as run when it is one of them or inside one", () => {
    const paths = ["tests/unit/", "tests/api/music.e2e.test.ts"];
    expect(isUnder("tests/unit/a.test.ts", paths)).toBe(true);
    expect(isUnder("tests/api/music.e2e.test.ts", paths)).toBe(true);
    expect(isUnder("tests/api/video.e2e.test.ts", paths)).toBe(false);
    expect(isUnder("tests/unitx/a.test.ts", paths)).toBe(false);
  });
});
