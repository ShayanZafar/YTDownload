import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  ALLOWED,
  EXCEPTIONS,
  declaredLicense,
  installedPackages,
  isAllowed,
  licenseFromText,
  licenseOf,
  violations,
} from "../../scripts/license-rules";

/**
 * scripts/licenses.ts (`npm run licenses`, part of `npm run verify`) fails the check when any
 * installed package carries a licence that isn't free and open source. These tests pin how a
 * package's licence is read and judged, so the check can't quietly let one through.
 */

describe("declaredLicense", () => {
  it("reads the string, object and array forms package.json allows", () => {
    expect(declaredLicense({ license: "MIT" })).toBe("MIT");
    expect(declaredLicense({ license: { type: "ISC", url: "x" } })).toBe("ISC");
    expect(declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "MIT OR Apache-2.0",
    );
    expect(declaredLicense({ licenses: ["BSD-3-Clause"] })).toBe("BSD-3-Clause");
  });

  it("is empty when nothing usable is declared", () => {
    expect(declaredLicense({})).toBe("");
    expect(declaredLicense({ license: 42 })).toBe("");
    expect(declaredLicense({ license: { url: "x" } })).toBe("");
  });
});

describe("isAllowed", () => {
  it("accepts the allowed licences and SPDX expressions they satisfy", () => {
    for (const license of ALLOWED) expect(isAllowed(license), license).toBe(true);
    expect(isAllowed("(MIT OR Apache-2.0)")).toBe(true);
    expect(isAllowed("MIT OR GPL-3.0")).toBe(true);
    expect(isAllowed("(MIT AND Zlib)")).toBe(true);
    expect(isAllowed("MIT OR (Apache-2.0 AND BSD-2-Clause)")).toBe(true);
  });

  it("refuses copyleft, source-available, unknown and missing licences", () => {
    for (const license of [
      "GPL-3.0-or-later",
      "AGPL-3.0",
      "LGPL-2.1",
      "BUSL-1.1",
      "SSPL-1.0",
      "Elastic-2.0",
      "UNLICENSED",
      "SEE LICENSE IN LICENSE.txt",
      "",
      "MIT AND GPL-3.0",
      "(GPL-2.0 OR AGPL-3.0)",
    ]) {
      expect(isAllowed(license), license || "(empty)").toBe(false);
    }
  });
});

describe("licenseFromText", () => {
  it("recognises the common licence texts and nothing else", () => {
    expect(licenseFromText("Permission is hereby granted, free of charge, to any person")).toBe(
      "MIT",
    );
    expect(
      licenseFromText(
        "Redistribution and use in source and binary forms ... Neither the name of the author",
      ),
    ).toBe("BSD-3-Clause");
    expect(licenseFromText("Redistribution and use in source and binary forms, with or")).toBe(
      "BSD-2-Clause",
    );
    expect(licenseFromText("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0");
    expect(
      licenseFromText("Permission to use, copy, modify, and/or distribute this software"),
    ).toBe("ISC");
    expect(licenseFromText("All rights reserved. Do not redistribute.")).toBe("");
  });
});

describe("installed packages", () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const write = (dir: string, pkg: object, licenseText?: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    if (licenseText !== undefined) writeFileSync(path.join(dir, "LICENSE"), licenseText);
  };

  it("finds top-level, scoped and nested packages and reads the LICENSE file as a fallback", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "yt-license-test-"));
    const nm = path.join(tmp, "node_modules");
    write(path.join(nm, "plain"), { name: "plain", version: "1.0.0", license: "MIT" });
    write(path.join(nm, "@scope", "scoped"), {
      name: "@scope/scoped",
      version: "2.0.0",
      license: "ISC",
    });
    write(
      path.join(nm, "plain", "node_modules", "nested"),
      { name: "nested", version: "3.0.0", license: "SEE LICENSE IN LICENSE" },
      "Permission is hereby granted, free of charge, to any person obtaining a copy",
    );
    write(path.join(nm, "silent"), { name: "silent", version: "4.0.0" }, "All rights reserved.");
    mkdirSync(path.join(nm, ".bin"));
    writeFileSync(path.join(nm, ".package-lock.json"), "{}");

    const found = installedPackages(nm).sort((a, b) => a.name.localeCompare(b.name));
    expect(found.map((p) => [p.name, p.version, p.license])).toEqual([
      ["@scope/scoped", "2.0.0", "ISC"],
      ["nested", "3.0.0", "MIT"],
      ["plain", "1.0.0", "MIT"],
      ["silent", "4.0.0", ""],
    ]);
    expect(violations(found).map((p) => p.name)).toEqual(["silent"]);
  });

  it("keeps a declared licence over the LICENSE file", () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "yt-license-test-"));
    write(tmp, { license: "GPL-3.0" }, "Permission is hereby granted, free of charge");
    expect(licenseOf({ license: "GPL-3.0" }, tmp)).toBe("GPL-3.0");
  });
});

describe("exceptions", () => {
  it("lets an agreed exception through, with its reason recorded", () => {
    const exception = {
      name: "ffmpeg-static",
      version: "5.3.0",
      license: "GPL-3.0-or-later",
      dir: "",
    };
    const stranger = { name: "other-gpl", version: "1.0.0", license: "GPL-3.0-or-later", dir: "" };
    expect(violations([exception, stranger])).toEqual([stranger]);
    for (const reason of EXCEPTIONS.values()) expect(reason.length).toBeGreaterThan(20);
  });
});
