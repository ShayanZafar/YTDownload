import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";

/**
 * The rules behind `npm run licenses` (scripts/licenses.ts): every installed package, dev tools
 * included, must carry a free, open-source licence. Nothing paid, source-available or
 * non-commercial-only. It reads each package.json under node_modules (nested ones too), so it
 * needs no package of its own.
 */

/** Free, open-source licences (SPDX identifiers) a package may carry. Widen only after asking. */
export const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "ISC",
  "BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "MPL-2.0",
  "BlueOak-1.0.0",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "Python-2.0",
  "PSF-2.0",
  "Zlib",
  "WTFPL",
]);

/** Packages allowed despite their licence, each with the reason. Add one only after asking. */
export const EXCEPTIONS = new Map([
  [
    "ffmpeg-static",
    "GPL-3.0-or-later: it ships ffmpeg's GPL build, which the app runs as a separate program",
  ],
]);

export type PackageJson = {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
};

export type Installed = { name: string; version: string; license: string; dir: string };

/** The licence a package.json declares, as an SPDX expression ("" when it declares none). */
export function declaredLicense(pkg: PackageJson): string {
  const value = pkg.license ?? pkg.licenses;
  const name = (item: unknown): string =>
    typeof item === "string"
      ? item
      : item && typeof item === "object" && "type" in item && typeof item.type === "string"
        ? item.type
        : "";
  const declared = Array.isArray(value)
    ? value.map(name).filter(Boolean).join(" OR ")
    : name(value);
  return declared.trim();
}

/** What a LICENSE file says, for the packages whose package.json declares nothing usable. */
export function licenseFromText(text: string): string {
  if (/Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /neither the name|endorse or promote/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  }
  if (/Apache License/i.test(text) && /Version 2\.0/.test(text)) return "Apache-2.0";
  if (/Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  return "";
}

/** Whether ALLOWED satisfies an SPDX expression: "A OR B" needs one of them, "A AND B" both. */
export function isAllowed(expression: string): boolean {
  const inner = expression
    .trim()
    .replace(/^\((.*)\)$/s, "$1")
    .trim();
  if (!inner) return false;
  if (/\sOR\s/.test(inner)) return inner.split(/\sOR\s/).some(isAllowed);
  if (/\sAND\s/.test(inner)) return inner.split(/\sAND\s/).every(isAllowed);
  return ALLOWED.has(inner);
}

/** The licence of an installed package: what it declares, else what its LICENSE file says. */
export function licenseOf(pkg: PackageJson, dir: string): string {
  const declared = declaredLicense(pkg);
  if (declared && !/^SEE LICENSE/i.test(declared)) return declared;
  const files = readdirSync(dir).filter((file) => /^(LICEN[CS]E|COPYING)/i.test(file));
  for (const file of files) {
    const guess = licenseFromText(readFileSync(path.join(dir, file), "utf8"));
    if (guess) return guess;
  }
  return declared;
}

/** Every package under a node_modules folder, nested ones included. */
export function installedPackages(nodeModules: string): Installed[] {
  const found: Installed[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(folder, entry.name);
      if (entry.name.startsWith("@")) {
        walk(dir); // a scope: its packages are one level down
        continue;
      }
      const file = path.join(dir, "package.json");
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, "utf8")) as PackageJson;
        found.push({
          name: pkg.name ?? entry.name,
          version: pkg.version ?? "",
          license: licenseOf(pkg, dir),
          dir,
        });
      }
      const nested = path.join(dir, "node_modules");
      if (existsSync(nested)) walk(nested);
    }
  };
  walk(nodeModules);
  return found;
}

/** The packages that break the rule: not allowed and not an agreed exception. */
export function violations(packages: Installed[]): Installed[] {
  return packages.filter((p) => !isAllowed(p.license) && !EXCEPTIONS.has(p.name));
}
