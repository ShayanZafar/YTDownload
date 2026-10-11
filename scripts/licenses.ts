import path from "path";
import { EXCEPTIONS, installedPackages, violations } from "./license-rules";

/**
 * `npm run licenses` (part of `npm run verify`) checks that every installed package carries a
 * free, open-source licence; the rules and the agreed exceptions are in scripts/license-rules.ts.
 * It prints one line when all is well, and the offending packages otherwise. Fix a failure by
 * replacing the package; an exception needs a reason, and asking first.
 */

const root = path.resolve(import.meta.dirname, "..");
const packages = installedPackages(path.join(root, "node_modules"));
const counts = new Map<string, number>();
for (const p of packages) {
  const label = p.license || "no licence declared";
  counts.set(label, (counts.get(label) ?? 0) + 1);
}
const problems = violations(packages);

if (problems.length > 0) {
  const lines = problems.map(
    (p) =>
      `  ${p.name}@${p.version}: ${p.license || "no licence declared"} (${path.relative(root, p.dir)})`,
  );
  console.error(
    `${problems.length} package(s) without a free, open-source licence:\n${lines.join("\n")}\n` +
      "Replace the package, or add it to EXCEPTIONS in scripts/license-rules.ts with the reason (ask first).",
  );
  process.exitCode = 1;
} else {
  const summary = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([license, n]) => `${license} ${n}`)
    .join(", ");
  console.log(
    `Licences OK: ${packages.length} packages (${summary}); agreed exceptions: ${[...EXCEPTIONS.keys()].join(", ")}.`,
  );
}
