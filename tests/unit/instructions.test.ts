import { describe, expect, it } from "vitest";
import {
  CLAUDE_MD_MAX_WORDS,
  RULES_FILE_MAX_WORDS,
  checkInstructions,
  countWords,
  expandBraces,
  matchesAny,
  rulePaths,
  splitFrontmatter,
  type InstructionsInput,
} from "../../scripts/instructions-rules";

/**
 * scripts/instructions.ts (`npm run instructions`, part of `npm run verify`) fails the check when
 * Claude's instructions grow past their budgets or a rules file loses its scope. These tests pin
 * each way it can fail, so CLAUDE.md can't quietly grow back.
 */

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

const TRACKED = [
  "CLAUDE.md",
  "server/audio.ts",
  "server/audio-source.ts",
  "client/src/pages/Home.tsx",
  "tests/unit/audio.test.ts",
  "vite.config.ts",
  "scripts/windows/app.ps1",
  ".github/workflows/install.yml",
];

const rules = (paths: string, body = "# Area\n\nA rule.") => `---\n${paths}\n---\n\n${body}\n`;

const input = (overrides: Partial<InstructionsInput> = {}): InstructionsInput => ({
  claudeMd: "# Project\n\nA few words.",
  rulesFiles: [{ file: ".claude/rules/audio.md", text: rules('paths:\n  - "server/audio*.ts"') }],
  tracked: TRACKED,
  ...overrides,
});

describe("countWords", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("one two\tthree\n\nfour  — `five`")).toBe(6);
    expect(countWords("")).toBe(0);
    expect(countWords("  \n ")).toBe(0);
  });

  it("leaves out HTML comments, on one line or several", () => {
    expect(countWords("one <!-- not these words --> two")).toBe(2);
    expect(countWords("one\n<!--\nnot\nthese\n-->\ntwo three")).toBe(3);
  });
});

describe("splitFrontmatter", () => {
  it("separates the YAML at the top from the text after it", () => {
    const { yaml, body } = splitFrontmatter('---\npaths:\n  - "a.ts"\n---\n# Title\n');
    expect(yaml).toBe('paths:\n  - "a.ts"');
    expect(body).toBe("# Title\n");
  });

  it("reads Windows line endings and a byte-order mark", () => {
    const { yaml, body } = splitFrontmatter('\uFEFF---\r\npaths: "a.ts"\r\n---\r\n# Title\r\n');
    expect(yaml).toBe('paths: "a.ts"');
    expect(body).toBe("# Title\r\n");
  });

  it("finds none when the file doesn't start with one", () => {
    expect(splitFrontmatter("# Title\n---\npaths: a\n---\n").yaml).toBeNull();
  });
});

describe("rulePaths", () => {
  it("reads a block list, quoted either way or not at all", () => {
    expect(
      rulePaths(`paths:\n  - "server/*.ts"\n  - 'client/**'\n  - tests/unit/a.test.ts`),
    ).toEqual(["server/*.ts", "client/**", "tests/unit/a.test.ts"]);
  });

  it("keeps the commas inside a brace pattern", () => {
    expect(rulePaths('paths:\n  - "client/**/*.{ts,tsx}"')).toEqual(["client/**/*.{ts,tsx}"]);
    expect(rulePaths("paths: [\"client/**/*.{ts,tsx}\", 'server/*.ts', docs/a.md]")).toEqual([
      "client/**/*.{ts,tsx}",
      "server/*.ts",
      "docs/a.md",
    ]);
  });

  it("reads a single glob, skips comments and stops at the next key", () => {
    expect(rulePaths('paths: "server/*.ts"')).toEqual(["server/*.ts"]);
    expect(
      rulePaths('paths:\n  # the server\n  - "server/*.ts" \n\n  - a.ts # a file\nother: x'),
    ).toEqual(["server/*.ts", "a.ts"]);
  });

  it("is null without a paths key, and empty for an empty list", () => {
    expect(rulePaths("description: x")).toBeNull();
    expect(rulePaths("paths:\nother: x")).toEqual([]);
    expect(rulePaths("paths: []")).toEqual([]);
  });
});

describe("matchesAny", () => {
  it("supports **, *, ? and {a,b}", () => {
    expect(matchesAny("server/audio*.ts", TRACKED)).toBe(true);
    expect(matchesAny("client/**", TRACKED)).toBe(true);
    expect(matchesAny("**/*.{ts,tsx}", ["vite.config.ts"])).toBe(true);
    expect(matchesAny("tests/unit/{audio,video}.test.ts", TRACKED)).toBe(true);
    expect(matchesAny("server/audio-sourc?.ts", TRACKED)).toBe(true);
    expect(matchesAny(".github/workflows/install.yml", TRACKED)).toBe(true);
  });

  it("matches only files, from the repo's root", () => {
    expect(matchesAny("server/video*.ts", TRACKED)).toBe(false);
    expect(matchesAny("audio.ts", TRACKED)).toBe(false);
    expect(matchesAny("server", TRACKED)).toBe(false);
  });
});

describe("expandBraces", () => {
  it("gives each alternative of a brace group", () => {
    expect(expandBraces("tests/unit/{a,b,c}.test.ts")).toEqual([
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/c.test.ts",
    ]);
  });

  it("expands several groups and nested ones", () => {
    expect(expandBraces("{server,shared}/{a,b}.ts")).toEqual([
      "server/a.ts",
      "server/b.ts",
      "shared/a.ts",
      "shared/b.ts",
    ]);
    expect(expandBraces("client/**/*.{ts,{tsx,css}}")).toEqual([
      "client/**/*.ts",
      "client/**/*.tsx",
      "client/**/*.css",
    ]);
  });

  it("leaves a glob without a group, or with a one-item group, as it is", () => {
    expect(expandBraces("server/**")).toEqual(["server/**"]);
    expect(expandBraces("server/{a}.ts")).toEqual(["server/{a}.ts"]);
    expect(expandBraces("{a}/{b,c}.ts")).toEqual(["{a}/b.ts", "{a}/c.ts"]);
  });
});

describe("checkInstructions", () => {
  it("passes small, scoped instructions and reports their sizes", () => {
    const report = checkInstructions(input());
    expect(report.problems).toEqual([]);
    expect(report.claudeMdWords).toBe(5);
    expect(report.rulesFiles).toBe(1);
    expect(report.globs).toBe(1);
    expect(report.largestRulesFile).toBe(4);
  });

  it(`fails a CLAUDE.md over ${CLAUDE_MD_MAX_WORDS} words, comments aside`, () => {
    const atLimit = `${words(CLAUDE_MD_MAX_WORDS)}\n<!-- a note for people -->`;
    expect(checkInstructions(input({ claudeMd: atLimit })).problems).toEqual([]);
    const problems = checkInstructions(
      input({ claudeMd: words(CLAUDE_MD_MAX_WORDS + 1) }),
    ).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`CLAUDE.md has ${CLAUDE_MD_MAX_WORDS + 1} words`);
  });

  it("fails without a CLAUDE.md", () => {
    expect(checkInstructions(input({ claudeMd: undefined })).problems[0]).toContain(
      "CLAUDE.md is missing",
    );
  });

  it(`fails a rules file over ${RULES_FILE_MAX_WORDS} words, its paths aside`, () => {
    const atLimit = rules('paths:\n  - "server/audio*.ts"', words(RULES_FILE_MAX_WORDS));
    const over = rules('paths:\n  - "server/audio*.ts"', words(RULES_FILE_MAX_WORDS + 1));
    const check = (text: string) =>
      checkInstructions(input({ rulesFiles: [{ file: ".claude/rules/a.md", text }] })).problems;
    expect(check(atLimit)).toEqual([]);
    expect(check(over)).toEqual([
      expect.stringContaining(`.claude/rules/a.md has ${RULES_FILE_MAX_WORDS + 1} words`),
    ]);
  });

  it("fails a rules file without paths, which would load with every request", () => {
    const texts = [
      "# Area\n\nA rule with no frontmatter.",
      rules("description: what it's for"),
      rules("paths: []"),
    ];
    for (const text of texts) {
      const problems = checkInstructions(
        input({ rulesFiles: [{ file: ".claude/rules/a.md", text }] }),
      ).problems;
      expect(problems).toEqual([expect.stringContaining(".claude/rules/a.md has no paths")]);
    }
  });

  it("fails each glob that matches no tracked file", () => {
    const text = rules('paths:\n  - "server/audio*.ts"\n  - "server/video*.ts"\n  - "docs/*.md"');
    const report = checkInstructions(input({ rulesFiles: [{ file: ".claude/rules/a.md", text }] }));
    expect(report.globs).toBe(3);
    expect(report.problems).toEqual([
      expect.stringContaining('.claude/rules/a.md: "server/video*.ts" matches no file git tracks'),
      expect.stringContaining('.claude/rules/a.md: "docs/*.md" matches no file git tracks'),
    ]);
  });

  it("fails a brace group when any one alternative matches nothing, a renamed file say", () => {
    const text = rules(
      'paths:\n  - "tests/unit/{audio,video,image}.test.ts"\n  - "server/{audio,audio-source}.ts"',
    );
    const report = checkInstructions(input({ rulesFiles: [{ file: ".claude/rules/a.md", text }] }));
    expect(report.globs).toBe(2);
    expect(report.problems).toEqual([
      '.claude/rules/a.md: "tests/unit/{audio,video,image}.test.ts" (its "tests/unit/video.test.ts", ' +
        '"tests/unit/image.test.ts") matches no file git tracks, so it never loads the rules for ' +
        "it: fix the glob or remove it.",
    ]);
  });

  it("checks every rules file", () => {
    const report = checkInstructions(
      input({
        rulesFiles: [
          { file: ".claude/rules/a.md", text: rules('paths: ["client/**", "vite.config.ts"]') },
          { file: ".claude/rules/area/b.md", text: rules('paths:\n  - "nothing/**"') },
        ],
      }),
    );
    expect(report.rulesFiles).toBe(2);
    expect(report.globs).toBe(3);
    expect(report.problems).toEqual([expect.stringContaining(".claude/rules/area/b.md")]);
  });
});
