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
        match: bare
          ? {
              title: "Bare Tone",
              artist: "Sine Wave",
              album: "Pure Tones",
              note: "the genre is the artist's: the song itself has none",
            }
          : null,
        source: bare ? "musicbrainz" : null,
        notes: bare ? [] : [`iTunes, “${track.title}”: nothing came back`],
      },
    });
  });

  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.getByRole("listitem");
  await expect(rows).toHaveCount(3);

  // By genre: each genre with its count, and the songs with none — found by typing.
  const genre = library.getByRole("combobox", { name: "Show songs of genre" });
  const genres = library.getByRole("listbox", { name: "Show songs of genre" });
  await genre.click();
  await expect(genres.getByRole("option")).toHaveText([
    "All genres",
    "Jazz (1)",
    "Rock (1)",
    "No genre (1)",
  ]);
  await genre.fill("ro");
  await expect(genres.getByRole("option")).toHaveText(["Rock (1)"]);
  await genres.getByRole("option", { name: "Rock (1)" }).click();
  await expect(genres).toBeHidden();
  await expect(genre).toHaveValue("Rock");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Rock One");
  // From the keyboard: Enter takes the first that has what's typed; Escape leaves it as it was.
  await genre.fill("no g");
  await genre.press("Enter");
  await expect(genre).toHaveValue("No genre");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Bare Tone");
  await genre.fill("jazz");
  await genre.press("Escape");
  await expect(genre).toHaveValue("No genre");
  await expect(rows).toHaveCount(1);
  await genre.press("ArrowDown");
  await genre.press("ArrowUp");
  await genre.press("ArrowUp");
  await genre.press("ArrowUp");
  await genre.press("Enter");
  await expect(genre).toHaveValue("");
  await expect(rows).toHaveCount(3);

  // Fill in details: the songs are looked up, and nothing is written until it's asked for.
  await library.getByRole("button", { name: "Fill in details" }).click();
  const panel = library.getByRole("region", { name: "Fill in details" });
  await panel.getByRole("button", { name: "Look up 3 songs" }).click();
  // Each song's outcome shows the moment it's done, while the others are still being looked up.
  const each = panel.getByRole("log", { name: "Each song" });
  await expect(each.getByRole("listitem").filter({ hasText: "“Bare Tone”" })).toContainText(
    "found on MusicBrainz: Genre: Electronic · Album: Pure Tones",
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
    "not found: iTunes, “Rock One”: nothing came back",
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
    panel.getByText(/Matched “Bare Tone” by Sine Wave, on Pure Tones \(MusicBrainz\)/),
  ).toBeVisible();
  // When the genre isn't the song's own, the review says whose it is.
  await expect(
    panel.getByText("The genre is the artist's: the song itself has none."),
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
  await genre.click();
  await expect(genres.getByRole("option", { name: "Electronic (1)" })).toHaveCount(1);
  await genre.press("Escape");
  await page.unroute("**/api/music");
  await Promise.all(held.map((go) => go()));
  await expect(each.getByRole("listitem")).toHaveText(["“Bare Tone” details added"]);

  // The file has them now: the list shows its new genre.
  await genre.click();
  await expect(genres.getByRole("option", { name: "Electronic (1)" })).toHaveCount(1);
  await expect(genres.getByRole("option", { name: /No genre/ })).toHaveCount(0);
  await genre.press("Escape");
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(rows.filter({ hasText: "Bare Tone" })).toContainText("Pure Tones");

  // Filled in, its album can be filtered on too, with the genre.
  const album = library.getByRole("combobox", { name: "Show songs of album" });
  await album.fill("pure");
  await library.getByRole("option", { name: "Pure Tones (1)" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Bare Tone");
  await library.getByRole("button", { name: "Show all" }).click();
  await expect(rows).toHaveCount(3);
});

test("songs no catalogue has are shown as Not found, and left out of Fill in details", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  // The server's list, with Rock One marked Not found (as a look-up no catalogue answered marks it).
  await page.route("**/api/music", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const body = await res.json();
    for (const track of body.tracks) track.detailsNotFound = track.title === "Rock One";
    await route.fulfill({ response: res, json: body });
  });
  const lookedUp: string[] = [];
  await page.route("**/api/music/*/details", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    lookedUp.push(route.request().url());
    await route.fulfill({
      json: { missing: ["year"], writable: true, found: null, match: null, source: null },
    });
  });

  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.locator("ol > li");
  await expect(rows).toHaveCount(3);
  const details = library.getByRole("combobox", { name: "Show songs of details" });
  await details.click();
  await library.getByRole("option", { name: "Not found (1)" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Rock One");

  // Shown on its own, it can be looked up again.
  await library.getByRole("button", { name: "Fill in details" }).click();
  const panel = library.getByRole("region", { name: "Fill in details" });
  await expect(panel).toContainText("These songs are marked Not found: they're looked up again.");
  await expect(panel.getByRole("button", { name: "Look up 1 song" })).toBeVisible();
  await panel.getByRole("button", { name: "Close", exact: true }).click();

  // With the others, it's left out.
  await details.click();
  await library.getByRole("option", { name: "Any details" }).click();
  await expect(rows).toHaveCount(3);
  await library.getByRole("button", { name: "Fill in details" }).click();
  await expect(panel).toContainText("1 song marked Not found (no catalogue had them) is left out");
  await panel.getByRole("button", { name: "Look up 2 songs" }).click();
  await expect(panel.getByText(/wasn't found|weren't found/)).toBeVisible();
  expect(lookedUp).toHaveLength(2);
});

test("a genre no catalogue has is guessed from the artist, and the review says it's a guess", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  const file = path.join(folder, "Low Tone.mp3");
  await song(file, { title: "Low Tone", artist: "Sine Wave" });
  // No catalogue has Low Tone: its artist's other songs here are Electronic.
  await page.route("**/api/music/*/details", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const tracks = (await (await request.get("/api/music")).json()).tracks as {
      id: string;
      title: string;
    }[];
    const track = tracks.find((t) => route.request().url().includes(`/${t.id}/`))!;
    const low = track.title === "Low Tone";
    await route.fulfill({
      json: {
        missing: low ? ["album", "genre", "year", "track", "cover"] : ["year"],
        writable: true,
        found: low ? { genre: "Electronic" } : null,
        match: null,
        source: low ? "artist" : null,
        guess: low ? "another song of Sine Wave's here is Electronic" : null,
        notFound: true,
      },
    });
  });

  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.locator("ol > li");
  await expect(rows.filter({ hasText: "Low Tone" })).toHaveCount(1);
  await library.getByRole("button", { name: "Fill in details" }).click();
  const panel = library.getByRole("region", { name: "Fill in details" });
  await panel.getByRole("button", { name: /^Look up \d+ songs$/ }).click();
  const each = panel.getByRole("log", { name: "Each song" });
  await expect(each.getByRole("listitem").filter({ hasText: "“Low Tone”" })).toContainText(
    "guessed from the artist: Genre: Electronic",
  );
  await expect(panel.getByText("Found details for 1 song.")).toBeVisible();
  await expect(panel.getByText("Adds Genre: Electronic")).toBeVisible();
  await expect(
    panel.getByText(
      "The genre is a guess from the artist: another song of Sine Wave's here is Electronic.",
    ),
  ).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: "Add details to “Low Tone”" })).toBeChecked();
  await panel.getByRole("button", { name: "Add details to 1 song" }).click();
  await expect(panel.getByText("Added details to 1 song.")).toBeVisible();
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  // Written into the file: the list has it.
  const tracks = (await (await request.get("/api/music")).json()).tracks as {
    title: string;
    genres: string[];
  }[];
  expect(tracks.find((t) => t.title === "Low Tone")?.genres).toEqual(["Electronic"]);
  await fs.rm(file, { force: true });
});
