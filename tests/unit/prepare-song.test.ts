import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioLinkOf } from "../../shared/soundcloud-link";
import { YouTubeRefused } from "../../server/youtube-limits";

// What a download and a save both do before any audio flows (server/prepare-song.ts),
// with the source, covers and catalogues played by stand-ins: no network.

const lookUpAudio = vi.hoisted(() => vi.fn());
vi.mock("../../server/audio-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/audio-source")>()),
  lookUpAudio,
}));
const coverFor = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../server/cover", () => ({ coverFor, fetchCover: vi.fn(async () => undefined) }));
const lookUpSong = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../../server/catalogues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/catalogues")>()),
  lookUpSong,
}));
vi.mock("../../server/details-log", () => ({
  downloadEntry: vi.fn(() => ""),
  logDetails: vi.fn(async () => {}),
}));

const { AudioLookUpError, prepareSong } = await import("../../server/prepare-song");

const link = audioLinkOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ")!;

beforeEach(() => {
  lookUpAudio.mockReset();
  lookUpAudio.mockResolvedValue({
    title: "Daft Punk - One More Time (Official Video)",
    artist: "DaftPunkVEVO",
    formatId: "251",
    acodec: "opus",
  });
});

describe("prepareSong", () => {
  it("names the file after the artist and title the video names, as MP3", async () => {
    const prepared = await prepareSong(link, { format: "mp3", cancelled: () => false });
    expect(prepared?.fileName).toBe("Daft Punk - One More Time.mp3");
    expect(prepared?.output.ext).toBe("mp3");
    await prepared?.output.cleanup();
  });

  it("uses the name chosen on the page, made safe", async () => {
    const prepared = await prepareSong(link, {
      format: "mp3",
      name: 'My: "mix"',
      cancelled: () => false,
    });
    expect(prepared?.fileName).not.toMatch(/[:"]/);
    expect(prepared?.fileName.endsWith(".mp3")).toBe(true);
    await prepared?.output.cleanup();
  });

  it("starts nothing when the page went away while the source was asked", async () => {
    expect(await prepareSong(link, { format: "mp3", cancelled: () => true })).toBeUndefined();
  });

  it("says when the source couldn't say what the audio is, and keeps YouTube's refusal as it is", async () => {
    lookUpAudio.mockRejectedValueOnce(new Error("Video unavailable"));
    await expect(prepareSong(link, { format: "mp3", cancelled: () => false })).rejects.toEqual(
      expect.objectContaining({ message: "Video unavailable" }),
    );
    lookUpAudio.mockRejectedValueOnce(new Error("Video unavailable"));
    await expect(
      prepareSong(link, { format: "mp3", cancelled: () => false }),
    ).rejects.toBeInstanceOf(AudioLookUpError);
    const refused = Object.create(YouTubeRefused.prototype) as YouTubeRefused;
    lookUpAudio.mockRejectedValueOnce(refused);
    await expect(prepareSong(link, { format: "mp3", cancelled: () => false })).rejects.toBe(
      refused,
    );
  });

  it("asks the folder's songs for a genre only when given them (a save)", async () => {
    const folderSongs = vi.fn(async () => []);
    const prepared = await prepareSong(link, {
      format: "mp3",
      folderSongs,
      cancelled: () => false,
    });
    await prepared?.output.cleanup();
    await vi.waitFor(() => expect(folderSongs).toHaveBeenCalled());
  });
});
