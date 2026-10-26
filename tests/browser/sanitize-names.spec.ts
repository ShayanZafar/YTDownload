import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Sanitize Filename and Rename: songs ffmpeg makes in a Save to folder, named and tagged
// the way videos and copies leave them, and the real app renaming and retagging the ones ticked.

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

let folder: string;
const NAMES = [
  "Junoon - Heer (Official Audio)",
  "Lithium HQ",
  "Queen - Bohemian Rhapsody",
  "Tone (1)",
  "Queen - Under Pressure",
  // A copy: its tidy name is the song beside it.
  "Queen - Under Pressure (1)",
  // In capitals, and the song first: the folder names Queen twice.
  "SOMEBODY TO LOVE - QUEEN",
];

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-sanitize-e2e-"));
  // No title tags: the list names them by their files.
  for (const name of NAMES) {
    await ffmpeg([
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
      ...["-c:a", "libmp3lame", "-b:a", "128k", path.join(folder, `${name}.mp3`)],
    ]);
  }
  // An M4A named .mp3, with a tidy name: offered for its extension (and its tags).
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
    ...["-c:a", "aac", "-f", "mp4", path.join(folder, "Faithless - Insomnia.mp3")],
  ]);
  // Tagged: a title with "ft." (offered for its title alone), and one tidy already.
  const tagged = (name: string, title: string, artist: string) =>
    ffmpeg([
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
      ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
      ...["-metadata", `title=${title}`, "-metadata", `artist=${artist}`],
      path.join(folder, `${name}.mp3`),
    ]);
  await tagged(
    "Kendrick Lamar - Money Trees ft. Jay Rock",
    "Money Trees ft. Jay Rock",
    "Kendrick Lamar",
  );
  await tagged("Queen - Don't Stop Me Now", "Don't Stop Me Now", "Queen");
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test("Sanitize Filename suggests tidy names, titles, artists and right extensions, changes only the ones ticked, and Rename changes one", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  // The songs' own list (the panel's lists are listed too).
  const rows = library.locator("ol > li");
  await expect(rows).toHaveCount(10);

  await library.getByRole("button", { name: "Sanitize Filename" }).click();
  const panel = library.getByRole("region", { name: "Sanitize Filename" });
  // The tidy one isn't offered.
  await expect(
    panel.getByText("9 songs could have a tidier name, title or artist.", { exact: false }),
  ).toBeVisible();
  await expect(
    panel.getByRole("checkbox", { name: "Rename “Queen - Don't Stop Me Now.mp3”" }),
  ).toHaveCount(0);
  // A song without tags is given the artist and title its name says; its name stays.
  const rhapsody = panel.getByRole("listitem").filter({ hasText: "Queen - Bohemian Rhapsody.mp3" });
  await expect(
    rhapsody.getByRole("textbox", { name: "Artist for “Queen - Bohemian Rhapsody.mp3”" }),
  ).toHaveValue("Queen");
  await expect(
    rhapsody.getByRole("textbox", { name: "Title for “Queen - Bohemian Rhapsody.mp3”" }),
  ).toHaveValue("Bohemian Rhapsody");
  await expect(rhapsody).toContainText("Its tags now: “Queen - Bohemian Rhapsody”, no artist");
  // A tagged song with "ft." in its title: its title alone.
  const moneyTrees = panel.getByRole("listitem").filter({ hasText: "Money Trees" });
  await expect(moneyTrees.getByRole("textbox", { name: /^Title for/ })).toHaveValue(
    "Money Trees (feat. Jay Rock)",
  );
  await expect(moneyTrees.getByRole("textbox", { name: /^Artist for/ })).toHaveCount(0);
  await expect(moneyTrees).toContainText(
    "Its tags now: “Money Trees ft. Jay Rock” by Kendrick Lamar",
  );

  // The copy would have the other song's name: never given, nor a "(2)" — it's shown
  // beside the other, to delete one.
  await expect(
    panel.getByText("1 song would have the name of another song", { exact: false }),
  ).toBeVisible();
  const copy = panel.getByRole("listitem").filter({ hasText: "Queen - Under Pressure (1).mp3" });
  await expect(copy.getByRole("checkbox")).toBeDisabled();
  await expect(copy).toContainText("“Queen - Under Pressure.mp3” (0:02) has that name already");
  await expect(
    copy.getByRole("button", { name: "Delete “Queen - Under Pressure.mp3”" }),
  ).toBeVisible();
  // Each can be listened to first, on its own.
  const player = page.getByRole("region", { name: "Music player" });
  await copy.getByRole("button", { name: "Play “Queen - Under Pressure.mp3”" }).click();
  await expect(player.getByTestId("player-title")).toHaveText("Queen - Under Pressure");
  await expect(
    copy.getByRole("button", { name: "Pause “Queen - Under Pressure.mp3”" }),
  ).toBeVisible();
  await copy.getByRole("button", { name: "Play “Queen - Under Pressure (1).mp3”" }).click();
  await expect(player.getByTestId("player-title")).toHaveText("Queen - Under Pressure (1)");
  await expect(
    copy.getByRole("button", { name: "Play “Queen - Under Pressure.mp3”" }),
  ).toBeVisible();
  // The one playing can be deleted: it leaves the player first.
  await copy.getByRole("button", { name: "Delete “Queen - Under Pressure (1).mp3”" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete from the folder?" });
  await dialog.getByRole("button", { name: /^Move to the (Trash|Recycle Bin)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(copy).toHaveCount(0);
  await expect(rows).toHaveCount(9);
  await expect(
    panel.getByText("would have the name of another song", { exact: false }),
  ).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", { name: "New name for “Junoon - Heer (Official Audio).mp3”" }),
  ).toHaveValue("Junoon - Heer");
  const insomnia = panel.getByRole("listitem").filter({ hasText: "Faithless - Insomnia.mp3" });
  await expect(insomnia.getByRole("textbox", { name: /^New name for/ })).toHaveValue(
    "Faithless - Insomnia",
  );
  await expect(insomnia).toContainText(".m4a");
  await expect(
    panel.getByRole("textbox", { name: "New name for “SOMEBODY TO LOVE - QUEEN.mp3”" }),
  ).toHaveValue("Queen - Somebody To Love");
  // A name can be changed first; one is left as it is.
  await panel
    .getByRole("textbox", { name: "New name for “Lithium HQ.mp3”" })
    .fill("Nirvana - Lithium");
  await panel.getByRole("checkbox", { name: "Rename “Tone (1).mp3”" }).uncheck();

  // The list isn't read again meanwhile (its answers held back): the renamed songs show at once.
  const held: (() => Promise<void>)[] = [];
  await page.route("**/api/music", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return new Promise<void>((resolve) => held.push(() => route.continue().then(resolve)));
  });
  await panel.getByRole("button", { name: "Rename 7 songs" }).click();
  await expect(panel.getByText("Renamed 7 songs.")).toBeVisible();
  // Listed by their new titles and artists.
  await expect(rows.filter({ hasText: "Lithium HQ" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Official Audio" })).toHaveCount(0);
  await expect(rows.filter({ hasText: "Somebody To Love" })).toContainText("Queen");
  await expect(rows.filter({ hasText: "Bohemian Rhapsody" })).toContainText("Queen");
  await expect(rows.filter({ hasText: "Money Trees (feat. Jay Rock)" })).toHaveCount(1);
  const each = panel.getByRole("log", { name: "Each song" });
  await expect(each.getByRole("listitem").filter({ hasText: "Lithium HQ.mp3" })).toContainText(
    "is now “Nirvana - Lithium.mp3”",
  );
  await expect(
    each.getByRole("listitem").filter({ hasText: "Queen - Bohemian Rhapsody.mp3" }),
  ).toContainText("has its title “Bohemian Rhapsody”, artist “Queen”");
  await Promise.all(held.map((go) => go()));
  await page.unroute("**/api/music");

  expect((await fs.readdir(folder)).sort()).toEqual([
    "Faithless - Insomnia.m4a",
    "Junoon - Heer.mp3",
    "Kendrick Lamar - Money Trees ft. Jay Rock.mp3",
    "Nirvana - Lithium.mp3",
    "Queen - Bohemian Rhapsody.mp3",
    "Queen - Don't Stop Me Now.mp3",
    "Queen - Somebody To Love.mp3",
    "Queen - Under Pressure.mp3",
    "Tone (1).mp3",
  ]);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(rows).toHaveCount(9);

  // Rename one song: its title and artist tags, and its file name with Sanitize's suggestion.
  await library.getByRole("button", { name: "Rename: “Tone (1)”" }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename" });
  await renameDialog.getByRole("button", { name: "Sanitize: “Tone”" }).click();
  await expect(renameDialog.getByRole("textbox", { name: "File name" })).toHaveValue("Tone");
  await renameDialog.getByRole("textbox", { name: "Title" }).fill("Test Tone");
  await renameDialog.getByRole("textbox", { name: "Artist" }).fill("Sine Wave");
  await renameDialog.getByRole("button", { name: "Save" }).click();
  await expect(renameDialog).toBeHidden();
  await expect(rows.filter({ hasText: "Test Tone" })).toContainText("Sine Wave");
  await expect(rows).toHaveCount(9);
  expect(await fs.readdir(folder)).toContain("Tone.mp3");
});
