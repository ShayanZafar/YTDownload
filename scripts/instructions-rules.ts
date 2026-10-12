import path from "path";

/**
 * The rules behind `npm run instructions` (scripts/instructions.ts, part of `npm run verify`).
 * Claude Code sends CLAUDE.md with every request, and a file in .claude/rules/ only while Claude
 * reads or edits a file its `paths:` globs match. Long instructions get followed less carefully,
 * so the check keeps them small and scoped: CLAUDE.md within CLAUDE_MD_MAX_WORDS, each rules file
 * within RULES_FILE_MAX_WORDS, and every rules file with `paths:` (without them it would load with
 * every request too) whose globs each match a file git tracks (a glob that matches nothing means
 * the rules never load for what they're about). Pure: the caller hands it the files' text and the
 * list of tracked files.
 */

/** CLAUDE.md's budget, in words. Raise it only with the owner's OK. */
export const CLAUDE_MD_MAX_WORDS = 600;

/** Each .claude/rules file's budget, in words, its `paths:` header aside. Raise it only with the owner's OK. */
export const RULES_FILE_MAX_WORDS = 500;

export interface RulesFile {
  /** The repo's path, with "/" (e.g. ".claude/rules/downloads.md"). */
  file: string;
  text: string;
}

export interface InstructionsInput {
  /** CLAUDE.md's text, or undefined when there's no such file. */
  claudeMd: string | undefined;
  rulesFiles: RulesFile[];
  /** The files git tracks (`git ls-files`), with "/". */
  tracked: string[];
}

export interface InstructionsReport {
  problems: string[];
  claudeMdWords: number;
  rulesFiles: number;
  globs: number;
  /** The most words in one rules file (0 with none). */
  largestRulesFile: number;
}

/** Words as whitespace-separated runs, leaving out HTML comments (`<!-- … -->`). */
export function countWords(text: string): number {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A Markdown file's YAML frontmatter (null without one) and the text after it. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const match = FRONTMATTER.exec(text);
  return match ? { yaml: match[1], body: text.slice(match[0].length) } : { yaml: null, body: text };
}

/** A YAML scalar without its quotes (or, unquoted, without a trailing `# comment`). */
function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

/** Splits a flow sequence's inside (`"a", 'b,c', d`) on the commas outside quotes and braces. */
function splitFlowItems(inside: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  let braces = 0;
  for (const char of inside) {
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      braces++;
    } else if (char === "}") {
      braces = Math.max(0, braces - 1);
    } else if (char === "," && braces === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map(unquote).filter((item) => item.length > 0);
}

/**
 * The globs of a rules file's `paths:` key — a block list (`- "server/audio*.ts"` lines), a flow
 * list (`["a", "b"]`) or a single glob — or null when the frontmatter has no `paths` key.
 */
export function rulePaths(yaml: string): string[] | null {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((line) => /^paths\s*:/.test(line));
  if (at === -1) return null;
  const rest = lines[at].replace(/^paths\s*:/, "").trim();
  if (rest.startsWith("[")) {
    return splitFlowItems(rest.replace(/^\[/, "").replace(/\]\s*(#.*)?$/, ""));
  }
  if (rest && !rest.startsWith("#")) return [unquote(rest)].filter((glob) => glob.length > 0);
  const globs: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) break;
    const glob = unquote(item[1]);
    if (glob) globs.push(glob);
  }
  return globs;
}

/** Whether `glob` (relative to the repo's root, as `paths:` takes it) matches one of `files`. */
export function matchesAny(glob: string, files: string[]): boolean {
  return files.some((file) => path.posix.matchesGlob(file, glob));
}

/** Checks CLAUDE.md and the .claude/rules files; `problems` is empty when all is well. */
export function checkInstructions(input: InstructionsInput): InstructionsReport {
  const problems: string[] = [];
  const claudeMdWords = input.claudeMd === undefined ? 0 : countWords(input.claudeMd);
  if (input.claudeMd === undefined) {
    problems.push("CLAUDE.md is missing: it's what Claude Code reads first in every session.");
  } else if (claudeMdWords > CLAUDE_MD_MAX_WORDS) {
    problems.push(
      `CLAUDE.md has ${claudeMdWords} words, over its ${CLAUDE_MD_MAX_WORDS}: move what matters ` +
        "for one area into that area's .claude/rules/ file, and what people read into the docs.",
    );
  }

  let globs = 0;
  let largestRulesFile = 0;
  for (const { file, text } of input.rulesFiles) {
    const { yaml, body } = splitFrontmatter(text);
    const words = countWords(body);
    largestRulesFile = Math.max(largestRulesFile, words);
    if (words > RULES_FILE_MAX_WORDS) {
      problems.push(
        `${file} has ${words} words, over the ${RULES_FILE_MAX_WORDS} a rules file may have: ` +
          "split it by area.",
      );
    }
    const paths = yaml === null ? null : rulePaths(yaml);
    if (paths === null || paths.length === 0) {
      problems.push(
        `${file} has no paths: without them it loads with every request, like CLAUDE.md. ` +
          'Start it with a "paths:" list of globs for the files it\'s about.',
      );
      continue;
    }
    globs += paths.length;
    for (const glob of paths) {
      if (!matchesAny(glob, input.tracked)) {
        problems.push(
          `${file}: "${glob}" matches no file git tracks, so it never loads the rules: ` +
            "fix the glob or remove it.",
        );
      }
    }
  }

  return {
    problems,
    claudeMdWords,
    rulesFiles: input.rulesFiles.length,
    globs,
    largestRulesFile,
  };
}
