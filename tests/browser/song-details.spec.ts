import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Your music by genre, and Fill in details: songs ffmpeg makes in a Save to
// folder, the music catalogues' answers played by a stand-in for the app's
// look-up route (nothing leaves this computer), and the real app writing the
// details picked into the file.

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

const song = (file: string, tags: Record<string, string>) =>
  ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=3"],
    ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
    ...Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
    file,
  ]);

let folder: string;

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-details-e2e-"));
  await song(path.join(folder, "Rock One.mp3"), { title: "Rock One", genre: "Rock" });
  await song(path.join(folder, "Jazz One.mp3"), { title: "Jazz One", genre: "Jazz" });
  await song(path.join(folder, "Bare Tone.mp3"), { title: "Bare Tone", artist: "Sine Wave" });
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test("songs can be shown by genre, and missing details filled in after a look", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  // What the catalogues have: Bare Tone's genre and album; Rock One, nothing (its
  // answer held back until the test lets it go); Jazz One can't be looked up.
  const lookedUp: string[] = [];
  let releaseRock!: () => void;
  const rockReleased = new Promise<void>((resolve) => (releaseRock = resolve));
  await page.route("**/api/music/*/details", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const tracks = (await (await request.get("/api/music")).json()).tracks as {
      id: string;
      title: string;
    }[];
    const track = tracks.find((t) => route.request().url().includes(`/${t.id}/`))!;
    lookedUp.push(track.title);
    if (track.title === "Jazz One") {
      return route.fulfill({
        status: 502,
        json: { message: "Couldn't reach the music catalogues (iTunes: no connection)." },
      });
    }
    if (track.title === "Rock One") await rockReleased;
    const bare = track.title === "Bare Tone";
    await route.fulfill({
      json: {
        missing: bare ? ["album", "genre", "year", "track", "cover"] : ["year", "track", "cover"],
        writable: true,
        found: bare ? { genre: "Electronic", album: "Pure Tones" } : null,
        match: bare ? { title: "Bare Tone", artist: "Sine Wave", album: "Pure Tones" } : null,
        source: bare ? "itunes" : null,
        notes: bare ? [] : [`iTunes, “${track.title}”: nothing came back`],
      },
    });
  });

  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.getByRole("listitem");
  await expect(rows).toHaveCount(3);

  // By genre: each genre with its count, and the songs with none.
  const genre = library.getByRole("combobox", { name: "Show songs of genre" });
  await genre.selectOption({ label: "Rock (1)" });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Rock One");
  await genre.selectOption({ label: "No genre (1)" });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Bare Tone");
  await genre.selectOption({ label: "All genres" });
  await expect(rows).toHaveCount(3);

  // Fill in details: the songs are looked up, and nothing is written until it's asked for.
  await library.getByRole("button", { name: "Fill in details" }).click();
  const panel = library.getByRole("region", { name: "Fill in details" });
  await panel.getByRole("button", { name: "Look up 3 songs" }).click();
  // Each song's outcome shows the moment it's done, while the others are still being looked up.
  const each = panel.getByRole("log", { name: "Each song" });
  await expect(each.getByRole("listitem").filter({ hasText: "“Bare Tone”" })).toContainText(
    "found on iTunes: Genre: Electronic · Album: Pure Tones",
  );
  await expect(each.getByRole("listitem").filter({ hasText: "“Jazz One”" })).toContainText(
    "couldn't be looked up: Couldn't reach the music catalogues (iTunes: no connection).",
  );
  await expect(panel.getByRole("progressbar", { name: "Looking up songs" })).toHaveAttribute(
    "aria-valuenow",
    "2",
  );
  releaseRock();
  await expect(panel.getByText("Found details for 1 song.")).toBeVisible();
  expect(lookedUp.sort()).toEqual(["Bare Tone", "Jazz One", "Rock One"]);
  await expect(each.getByRole("listitem").filter({ hasText: "“Rock One”" })).toContainText(
    "not found in iTunes or Deezer: iTunes, “Rock One”: nothing came back",
  );
  // Every song's outcome is also kept in the details log, which the panel links to.
  await expect(panel.getByRole("link", { name: /The details log/ })).toHaveAttribute(
    "href",
    "/api/details-log",
  );
  await expect(panel.getByText("1 song wasn't found")).toBeVisible();
  const tick = panel.getByRole("checkbox", { name: "Add details to “Bare Tone”" });
  await expect(tick).toBeChecked();
  await expect(panel.getByText("Adds Genre: Electronic · Album: Pure Tones")).toBeVisible();
  await expect(
    panel.getByText(/Matched “Bare Tone” by Sine Wave, on Pure Tones \(iTunes\)/),
  ).toBeVisible();

  // Unticked, there's nothing to write.
  await tick.uncheck();
  await expect(panel.getByRole("button", { name: "Add details to 0 songs" })).toBeDisabled();
  await tick.check();
  // The list isn't read again meanwhile (its answers held back): the song written shows its
  // new details at once all the same, from what the write answered.
  const held: (() => Promise<void>)[] = [];
  await page.route("**/api/music", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return new Promise<void>((resolve) => held.push(() => route.continue().then(resolve)));
  });
  await panel.getByRole("button", { name: "Add details to 1 song" }).click();
  await expect(panel.getByText("Added details to 1 song.")).toBeVisible();
  await expect(genre.locator("option", { hasText: "Electronic (1)" })).toHaveCount(1);
  await page.unroute("**/api/music");
  await Promise.all(held.map((go) => go()));
  await expect(each.getByRole("listitem")).toHaveText(["“Bare Tone” details added"]);

  // The file has them now: the list shows its new genre.
  await expect(genre.locator("option", { hasText: "Electronic (1)" })).toHaveCount(1);
  await expect(genre.locator("option", { hasText: "No genre" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(rows.filter({ hasText: "Bare Tone" })).toContainText("Pure Tones");

  // Filled in, its album can be filtered on too, with the genre.
  await library.getByRole("combobox", { name: "Show songs of album" }).selectOption({
    label: "Pure Tones (1)",
  });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Bare Tone");
  await library.getByRole("button", { name: "Show all" }).click();
  await expect(rows).toHaveCount(3);
});
