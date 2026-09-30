import { describe, it, expect } from "vitest";
import {
  fileNameFromDisposition,
  formatBytes,
  numberedName,
  saveToFolder,
} from "../../client/src/lib/save-folder";

describe("fileNameFromDisposition", () => {
  it("reads the name the server sends", () => {
    expect(fileNameFromDisposition('attachment; filename="Me at the zoo.mp3"')).toBe(
      "Me at the zoo.mp3",
    );
    expect(fileNameFromDisposition("attachment; filename=song.opus")).toBe("song.opus");
    expect(
      fileNameFromDisposition(
        "attachment; filename=\"Beyonce.mp3\"; filename*=UTF-8''Beyonc%C3%A9%20-%20Halo.mp3",
      ),
    ).toBe("Beyoncé - Halo.mp3");
  });

  it("makes the name safe for Windows", () => {
    expect(fileNameFromDisposition('attachment; filename="AC/DC: Back in Black?.mp3"')).toBe(
      "AC_DC_ Back in Black_.mp3",
    );
    expect(fileNameFromDisposition('attachment; filename="trailing dots..."')).toBe(
      "trailing dots",
    );
  });

  it("falls back when there's no usable name", () => {
    expect(fileNameFromDisposition(null)).toBe("audio");
    expect(fileNameFromDisposition("attachment")).toBe("audio");
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A", "x.mp3")).toBe("x.mp3");
  });
});

describe("numberedName", () => {
  it("numbers copies the way browsers do", () => {
    expect(numberedName("Song.mp3", 0)).toBe("Song.mp3");
    expect(numberedName("Song.mp3", 1)).toBe("Song (1).mp3");
    expect(numberedName("No extension", 2)).toBe("No extension (2)");
  });
});

describe("formatBytes", () => {
  it("shows sizes the way people read them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(2_457_600)).toBe("2.3 MB");
  });
});

/** A stand-in for a folder picked with showDirectoryPicker, kept in memory. */
class FakeFolder {
  name = "Music";
  files = new Map<string, Buffer>();
  folders = new Set<string>();

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (this.folders.has(name)) throw new DOMException("is a folder", "TypeMismatchError");
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException("not found", "NotFoundError");
      this.files.set(name, Buffer.alloc(0)); // like the real API: an empty file right away
    }
    return {
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return new WritableStream<Uint8Array>({
          write: (chunk) => {
            chunks.push(chunk);
          },
          // Like the real API, the content only lands when the stream closes.
          close: () => {
            this.files.set(name, Buffer.concat(chunks));
          },
        });
      },
    };
  }

  async removeEntry(name: string) {
    this.files.delete(name);
  }
}

const asFolder = (folder: FakeFolder) => folder as unknown as FileSystemDirectoryHandle;

const audioResponse = (chunks: Uint8Array[], name = "Song.mp3") =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "Content-Disposition": `attachment; filename="${name}"` } },
  );

describe("saveToFolder", () => {
  it("writes the download into the folder and reports progress", async () => {
    const folder = new FakeFolder();
    const progress: number[] = [];
    const name = await saveToFolder(asFolder(folder), "/api/video/download?url=x", {
      fetchImpl: async () => audioResponse([new Uint8Array(1000), new Uint8Array(500)]),
      onProgress: (bytes) => progress.push(bytes),
    });

    expect(name).toBe("Song.mp3");
    expect(folder.files.get("Song.mp3")?.length).toBe(1500);
    expect(progress).toEqual([1000, 1500]);
  });

  it("never overwrites an existing file", async () => {
    const folder = new FakeFolder();
    folder.files.set("Song.mp3", Buffer.from("old"));
    folder.files.set("Song (1).mp3", Buffer.from("older"));
    folder.folders.add("Song (2).mp3");

    const name = await saveToFolder(asFolder(folder), "/x", {
      fetchImpl: async () => audioResponse([new Uint8Array(10)]),
    });
    expect(name).toBe("Song (3).mp3");
    expect(folder.files.get("Song.mp3")?.toString()).toBe("old");
  });

  it("passes on the server's error and leaves no file behind", async () => {
    const folder = new FakeFolder();
    await expect(
      saveToFolder(asFolder(folder), "/x", {
        fetchImpl: async () =>
          new Response("Couldn't download the audio: Sign in to confirm you're not a bot", {
            status: 502,
          }),
      }),
    ).rejects.toThrow(/not a bot/);
    expect(folder.files.size).toBe(0);
  });

  it("removes the unfinished file when cancelled", async () => {
    const folder = new FakeFolder();
    const controller = new AbortController();
    // Audio that keeps coming until the download is cancelled.
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.enqueue(new Uint8Array(100));
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    const saving = saveToFolder(asFolder(folder), "/x", {
      signal: controller.signal,
      fetchImpl: async () =>
        new Response(body, { headers: { "Content-Disposition": 'attachment; filename="S.mp3"' } }),
      onProgress: (bytes) => {
        if (bytes >= 300) controller.abort();
      },
    });

    await expect(saving).rejects.toThrow();
    expect(folder.files.has("S.mp3")).toBe(false);
  });
});
