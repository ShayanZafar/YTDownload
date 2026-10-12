import { execFileSync } from "child_process";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import {
  CLAUDE_MD_MAX_WORDS,
  RULES_FILE_MAX_WORDS,
  checkInstructions,
  type RulesFile,
} from "./instructions-rules";

/**
 * `npm run instructions` (part of `npm run verify`) keeps Claude's instructions small and scoped:
 * CLAUDE.md, sent with every request, within its word budget, and each .claude/rules/ file within
 * its own, with `paths:` globs that each match a file git tracks. The rules are in
 * scripts/instructions-rules.ts. It prints one line when all is well, and each problem otherwise.
 */

const root = path.resolve(import.meta.dirname, "..");
const RULES_DIR = ".claude/rules";

function read(file: string): string | undefined {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

function rulesFiles(): RulesFile[] {
  let names: string[];
  try {
    names = readdirSync(path.join(root, RULES_DIR), { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return names
    .map((name) => `${RULES_DIR}/${name.split(path.sep).join("/")}`)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({ file, text: read(file) ?? "" }));
}

let tracked: string[];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch (error) {
  console.error(`Couldn't list the files git tracks (git ls-files): ${(error as Error).message}`);
  process.exit(1);
}

const report = checkInstructions({
  claudeMd: read("CLAUDE.md"),
  rulesFiles: rulesFiles(),
  tracked,
});

if (report.problems.length > 0) {
  console.error(
    `Claude's instructions need attention:\n${report.problems.map((p) => `  ${p}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Instructions: CLAUDE.md ${report.claudeMdWords}/${CLAUDE_MD_MAX_WORDS} words; ` +
      `${report.rulesFiles} rules files (largest ${report.largestRulesFile}/${RULES_FILE_MAX_WORDS} words), ` +
      `${report.globs} globs, each matching a tracked file`,
  );
}
