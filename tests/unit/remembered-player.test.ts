import { describe, expect, it } from "vitest";
import {
  EMPTY_QUEUE,
  currentOf,
  deviceTrack,
  folderTrack,
  type PlayerTrack,
  type Queue,
} from "../../client/src/lib/music";
import {
  MAX_REMEMBERED_SONGS,
  parseRememberedQueue,
  queueToRemember,
  rememberedQueueText,
  resumeText,
  resumeTimeFor,
} from "../../client/src/lib/remembered-player";

const folderSong = (n: number, extra: { duration?: number | null } = {}) =>
  folderTrack({
    id: `song${n}`.padEnd(22, "x"),
    path: `Artist ${n}\\Song ${n}.mp3`,
    title: `Song ${n}`,
    artist: `Artist ${n}`,
    album: null,
    genres: [],
    year: null,
    duration: extra.duration === undefined ? 200 : extra.duration,
    addedAt: "2026-10-01T10:00:00.000Z",
    size: 1000,
    realType: null,
    notAudio: null,
  });

const deviceSong = (name: string) => deviceTrack(new File(["x"], name, { lastModified: 1 }));

const queueOf = (tracks: PlayerTrack[], order: number[], position: number): Queue => ({
  tracks,
  order,
  position,
});

const titles = (queue: Queue) => queue.order.map((index) => queue.tracks[index].title);

describe("the player's queue, remembered for next time", () => {
  it("keeps the folder songs, in play order, and the song playing", () => {
    const songs = [folderSong(1), folderSong(2), folderSong(3)];
    // Shuffled: 3, 1, 2 — the second one is playing.
    const queue = queueOf(songs, [2, 0, 1], 1);
    const text = rememberedQueueText(queue)!;
    const back = parseRememberedQueue(text)!;
    expect(titles(back)).toEqual(["Song 3", "Song 1", "Song 2"]);
    expect(currentOf(back)?.title).toBe("Song 1");
    // The songs come back as they were, so they're the same songs to the player.
    expect(back.tracks).toEqual(songs);
  });

  it("leaves out songs picked on a device (they're gone with the page)", () => {
    const tracks = [folderSong(1), deviceSong("Phone.mp3"), folderSong(2)];
    const kept = queueToRemember(queueOf(tracks, [0, 1, 2], 2))!;
    expect(titles(kept)).toEqual(["Song 1", "Song 2"]);
    expect(currentOf(kept)?.title).toBe("Song 2");
  });

  it("remembers nothing when there's no song, or the song is from a device", () => {
    expect(rememberedQueueText(EMPTY_QUEUE)).toBeNull();
    const tracks = [folderSong(1), deviceSong("Phone.mp3")];
    expect(rememberedQueueText(queueOf(tracks, [0, 1], 1))).toBeNull();
  });

  it("keeps at most MAX_REMEMBERED_SONGS, around the song playing", () => {
    const count = MAX_REMEMBERED_SONGS + 500;
    const tracks = Array.from({ length: count }, (_, i) => folderSong(i));
    const order = tracks.map((_, i) => count - 1 - i); // backwards
    const kept = queueToRemember(queueOf(tracks, order, 300))!;
    expect(kept.tracks).toHaveLength(MAX_REMEMBERED_SONGS);
    expect(currentOf(kept)?.title).toBe(`Song ${count - 1 - 300}`);
    // A few songs before it (so Previous still goes back), then what's next.
    expect(kept.position).toBe(50);
    expect(titles(kept)[0]).toBe(`Song ${count - 1 - 250}`);
    // Its songs stay in their listed order (for turning shuffle off).
    expect(kept.tracks.map((track) => track.title)).toEqual([...titles(kept)].reverse());
    // Near the end of the queue, the window ends with it.
    const late = queueToRemember(queueOf(tracks, order, count - 1))!;
    expect(late.tracks).toHaveLength(MAX_REMEMBERED_SONGS);
    expect(late.position).toBe(MAX_REMEMBERED_SONGS - 1);
  });

  it("reads back nothing it can't trust", () => {
    const good = rememberedQueueText(queueOf([folderSong(1), folderSong(2)], [0, 1], 0))!;
    const data = JSON.parse(good) as { order: number[]; position: number; tracks: unknown[] };
    const broken = [
      null,
      "",
      "not json",
      "[]",
      JSON.stringify({ ...data, order: [0, 0] }),
      JSON.stringify({ ...data, order: [0] }),
      JSON.stringify({ ...data, order: [0, 2] }),
      JSON.stringify({ ...data, position: 2 }),
      JSON.stringify({ ...data, tracks: [] }),
      // A song id the app would never give (the page never sends a path).
      JSON.stringify({
        ...data,
        tracks: [{ ...(data.tracks[0] as object), id: "../../etc/passwd" }, data.tracks[1]],
      }),
    ];
    for (const text of broken) expect(parseRememberedQueue(text)).toBeNull();
    expect(parseRememberedQueue(good)).not.toBeNull();
  });
});

describe("where the song was", () => {
  it("carries on in the same song", () => {
    const song = folderSong(1);
    expect(resumeTimeFor(resumeText(song.key, 42.345), song)).toBe(42.3);
  });

  it("starts from the beginning otherwise", () => {
    const song = folderSong(1);
    expect(resumeTimeFor(null, song)).toBe(0);
    expect(resumeTimeFor("nonsense", song)).toBe(0);
    expect(resumeTimeFor(resumeText(folderSong(2).key, 42), song)).toBe(0);
    // It had finished.
    expect(resumeTimeFor(resumeText(song.key, 199.5), song)).toBe(0);
    // A song of unknown length carries on wherever it was.
    const unknown = folderSong(3, { duration: null });
    expect(resumeTimeFor(resumeText(unknown.key, 500), unknown)).toBe(500);
  });
});
