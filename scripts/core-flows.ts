import { readFileSync } from "fs";
import path from "path";
import { checkCoreFlows, isUnder, vitestPaths } from "./core-flows-rules";

/**
 * `npm run core-flows` (part of `npm run verify`) checks docs/core-flows.md: every core flow names
 * a unit, an integration and a UI test (or a counted gap, "—"), every named test exists, unit and
 * integration tests are ones verify runs, and the gap count matches "Gaps allowed". The rules are
 * in scripts/core-flows-rules.ts. It prints one line when all is well, and each problem otherwise.
 */

const root = path.resolve(import.meta.dirname, "..");
const DOC = "docs/core-flows.md";

function read(file: string): string | undefined {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

const markdown = read(DOC);
if (markdown === undefined) {
  console.error(`${DOC} is missing: it lists the core flows and their tests (see CLAUDE.md).`);
  process.exit(1);
}
const verify = (JSON.parse(read("package.json") ?? "{}") as { scripts?: Record<string, string> })
  .scripts?.verify;
const inVerify = vitestPaths(verify ?? "");
const report = checkCoreFlows(markdown, {
  readFile: read,
  runsInVerify: (file) => isUnder(file, inVerify),
});

if (report.problems.length > 0) {
  console.error(
    `${DOC} doesn't match the tests:\n${report.problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Core flows: ${report.flows} flows, ${report.tests} tests named, ${report.gaps} gaps (allowed ${report.gapsAllowed})`,
  );
}
