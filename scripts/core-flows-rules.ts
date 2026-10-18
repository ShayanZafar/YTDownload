/**
 * The rules behind `npm run core-flows` (scripts/core-flows.ts, part of `npm run verify`).
 * docs/core-flows.md lists the core flows, what a person relies on the app for, each with the
 * tests that cover it at three levels: unit (one module, no network), integration (several parts
 * together through the real routes and pipeline, outside services played by stand-ins) and UI (a
 * real browser driving the running app). A missing level is a gap, written "—". The check fails
 * when a flow lacks a level without saying so, when a named test no longer exists, when a UI test
 * is one of the @live ones (the real services: pull requests don't run them), or when the
 * number of gaps differs from the "Gaps allowed: N" line, which only ever goes down. Pure: the
 * caller hands it the file's text and a way to read the test files.
 */

export const LEVELS = ["Unit", "Integration", "UI"] as const;
export type Level = (typeof LEVELS)[number];

/** The mark for a level with no test yet. */
export const GAP = "—";

export interface TestRef {
  file: string;
  title: string;
}

export interface CoreFlowsReport {
  problems: string[];
  flows: number;
  /** Distinct tests named (file and title). */
  tests: number;
  gaps: number;
  gapsAllowed: number | null;
}

export interface CheckOptions {
  /** A test file's text, or undefined when there's no such file. Paths are the repo's, with "/". */
  readFile: (file: string) => string | undefined;
  /** Whether `npm run verify` runs this file (unit and integration tests must run on every change). */
  runsInVerify: (file: string) => boolean;
}

const HEADER = ["Flow", ...LEVELS];
const REF = /^`([^`]+)`\s*›\s*(.+)$/;
const GAPS_LINE = /^Gaps allowed:\s*(\d+)\s*$/m;
/** `it(`, `test(`, `test.describe(`, `it.each([…])(` and the like: the title comes next. */
const TEST_CALL = /\b(?:it|test|describe)\b[\w.]*\((?:\[[^\]]*\]\)\()?/g;

/** The test files and folders an npm script's `vitest run` is given (package.json's verify). */
export function vitestPaths(script: string): string[] {
  const run = /\bvitest run\b([^&|;]*)/.exec(script);
  return run ? run[1].split(/\s+/).filter((arg) => arg && !arg.startsWith("-")) : [];
}

/** Whether `file` is one of `paths`, or inside one of them. */
export function isUnder(file: string, paths: string[]): boolean {
  return paths.some((p) => file === p || file.startsWith(`${p.replace(/\/+$/, "")}/`));
}

/** The cells of one Markdown table row, trimmed, without the outer pipes. */
export function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Where `source` declares a test (or describe) whose first argument is the quoted `title` (on
 * the call's line, or the next, as Prettier puts a long one): what comes after the title, up to
 * the test's body — its options, such as tags. Undefined when there's no such test.
 */
function declarationOf(source: string, title: string): string | undefined {
  const quoted = ['"', "'", "`"].map((q) => q + title.replaceAll(q, `\\${q}`) + q);
  for (const call of source.matchAll(TEST_CALL)) {
    const rest = source.slice(call.index + call[0].length).trimStart();
    const q = quoted.find((candidate) => rest.startsWith(candidate));
    if (q === undefined) continue;
    const after = rest.slice(q.length);
    const body = after.search(/=>|\bfunction\b/);
    return body === -1 ? after : after.slice(0, body);
  }
  return undefined;
}

/** Whether `source` declares a test (or describe) whose first argument is the quoted `title`. */
export function declaresTest(source: string, title: string): boolean {
  return declarationOf(source, title) !== undefined;
}

/** The tag of the browser tests that use the real YouTube, Spotify or SoundCloud (playwright.config.ts). */
export const LIVE_TAG = "@live";

/** Whether the test titled `title` in `source` is tagged @live (`{ tag: "@live" }` or in a list). */
export function isLiveTest(source: string, title: string): boolean {
  const options = declarationOf(source, title);
  return options !== undefined && new RegExp(`["'\`]${LIVE_TAG}["'\`]`).test(options);
}

/** Checks docs/core-flows.md's text; `problems` is empty when all is well. */
export function checkCoreFlows(markdown: string, options: CheckOptions): CoreFlowsReport {
  const problems: string[] = [];
  const gapsMatch = GAPS_LINE.exec(markdown);
  const gapsAllowed = gapsMatch ? Number(gapsMatch[1]) : null;
  if (gapsAllowed === null) problems.push('There is no "Gaps allowed: N" line.');

  const rows = markdown
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("|"))
    .map(tableCells);
  const [header, separator, ...flows] = rows;
  if (!header || header.join("|") !== HEADER.join("|") || !separator) {
    problems.push(`There is no table headed | ${HEADER.join(" | ")} |.`);
    return { problems, flows: 0, tests: 0, gaps: 0, gapsAllowed };
  }
  if (flows.length === 0) problems.push("The table lists no flows.");

  let gaps = 0;
  const named = new Set<string>();
  for (const cells of flows) {
    const flow = cells[0] || "(a row with no flow)";
    if (cells.length !== HEADER.length) {
      problems.push(`"${flow}": has ${cells.length} cells, not ${HEADER.length}.`);
      continue;
    }
    if (!cells[0]) problems.push("A row has no flow named in its first cell.");
    LEVELS.forEach((level, i) => {
      const cell = cells[i + 1];
      const where = `"${flow}", ${level}`;
      if (!cell) {
        problems.push(`${where}: the cell is empty; name a test, or write ${GAP} for a gap.`);
        return;
      }
      if (cell === GAP) {
        gaps++;
        return;
      }
      for (const part of cell.split(/<br\s*\/?>/)) {
        const ref = REF.exec(part.trim());
        if (!ref) {
          problems.push(
            `${where}: "${part.trim()}" isn't \`file\` › test title (or ${GAP}, alone, for a gap).`,
          );
          continue;
        }
        const [, file, title] = ref;
        const problem = refProblem({ file, title: title.trim() }, level, options);
        if (problem) problems.push(`${where}: ${problem}`);
        else named.add(`${file} › ${title.trim()}`);
      }
    });
  }

  if (gapsAllowed !== null && gaps < gapsAllowed) {
    problems.push(
      `${gaps} gaps, fewer than allowed (${gapsAllowed}): close the gap count: set Gaps allowed: ${gaps}.`,
    );
  } else if (gapsAllowed !== null && gaps > gapsAllowed) {
    problems.push(
      `${gaps} gaps, more than allowed (${gapsAllowed}): a core flow lost a test. ` +
        "Name one for each new gap; gaps only ever go down.",
    );
  }
  return { problems, flows: flows.length, tests: named.size, gaps, gapsAllowed };
}

/** What's wrong with one named test, if anything. */
function refProblem(ref: TestRef, level: Level, options: CheckOptions): string | undefined {
  const source = options.readFile(ref.file);
  if (source === undefined) return `${ref.file} doesn't exist.`;
  if (!declaresTest(source, ref.title)) {
    return `${ref.file} has no test titled "${ref.title}".`;
  }
  if (level === "UI" && !/^tests\/browser\/.+\.spec\.ts$/.test(ref.file)) {
    return `${ref.file} isn't a browser test (tests/browser/*.spec.ts).`;
  }
  if (level === "UI" && isLiveTest(source, ref.title)) {
    return (
      `${ref.file} › ${ref.title} is tagged ${LIVE_TAG}: it uses the real YouTube, Spotify or ` +
      "SoundCloud, so pull requests don't run it. Name a test that uses stand-ins."
    );
  }
  if (level !== "UI" && !options.runsInVerify(ref.file)) {
    return `npm run verify doesn't run ${ref.file}: unit and integration tests must run on every change, without the network.`;
  }
  return undefined;
}
