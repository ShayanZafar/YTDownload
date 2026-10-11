import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  folderName,
  parseSaveEvent,
  saveOnServer,
} from "../../client/src/lib/save-to-folder";

const encoder = new TextEncoder();
const SONG = { url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", format: "mp3" as const };
const DONE = {
  type: "done",
  fileName: "Me at the zoo.mp3",
  folder: "C:\\Users\\me\\Music",
  path: "C:\\Users\\me\\Music\\Me at the zoo.mp3",
  bytes: 761400,
};

/**
 * A fetch that answers with `chunks` as a streamed body — split wherever the
 * test likes, as the network may — and fails the stream if the signal aborts.
 */
function streamingFetch(chunks: string[], { hang = false } = {}) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        init?.signal?.addEventListener("abort", () =>
          controller.error(new DOMException("The user aborted a request.", "AbortError")),
        );
        if (!hang) controller.close();
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
  });
}

describe("saveOnServer", () => {
  it("reports progress as lines arrive, however they're split, and returns the saved file", async () => {
    const lines = [
      { type: "progress", bytes: 120 },
      { type: "progress", bytes: 350_000 },
      DONE,
    ].map((event) => `${JSON.stringify(event)}\n`);
    const text = lines.join("");
    // Cut mid-line, like a network might.
    const fetchImpl = streamingFetch([text.slice(0, 7), text.slice(7, 40), text.slice(40)]);
    const progress: number[] = [];

    const saved = await saveOnServer(
      { ...SONG, name: "Zoo" },
      { fetchImpl, onProgress: (bytes) => progress.push(bytes) },
    );

    expect(saved).toEqual(DONE);
    expect(progress).toEqual([120, 350_000]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/video/save");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ ...SONG, name: "Zoo" });
  });

  it("passes on the app's reason when the save fails part-way", async () => {
    const fetchImpl = streamingFetch([
      `${JSON.stringify({ type: "progress", bytes: 1000 })}\n`,
      `${JSON.stringify({ type: "error", message: "Couldn't download the audio: HTTP Error 403" })}\n`,
    ]);
    await expect(saveOnServer(SONG, { fetchImpl })).rejects.toThrow(/HTTP Error 403/);
  });

  it("passes on the app's reason when it refuses straight away, with the status", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "The folder “D:\\Music” doesn't exist." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const failure = saveOnServer(SONG, { fetchImpl });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 404, message: /doesn't exist/ });
  });

  it("says when YouTube refused the save (it's limiting the computer): a 502 that says so", async () => {
    const message = "YouTube is limiting this computer right now. Try again in a few minutes.";
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message, source: "youtube", limited: true }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const failure = saveOnServer(SONG, { fetchImpl });
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 502, limited: true, message });
  });

  it("isn't limited for any other failure", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Couldn't download the audio: gone" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(saveOnServer(SONG, { fetchImpl })).rejects.toMatchObject({
      status: 502,
      limited: false,
      message: "Couldn't download the audio: gone",
    });
  });

  it("notices when the answer stops before the file is saved", async () => {
    const fetchImpl = streamingFetch([`${JSON.stringify({ type: "progress", bytes: 5 })}\n`]);
    await expect(saveOnServer(SONG, { fetchImpl })).rejects.toThrow(/stopped answering/);
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    const fetchImpl = streamingFetch([`${JSON.stringify({ type: "progress", bytes: 5 })}\n`], {
      hang: true,
    });
    const saving = saveOnServer(SONG, {
      fetchImpl,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("parseSaveEvent", () => {
  it("reads one line of progress", () => {
    expect(parseSaveEvent('{"type":"progress","bytes":42}')).toEqual({
      type: "progress",
      bytes: 42,
    });
  });

  it("ignores blank lines and anything it doesn't recognise", () => {
    expect(parseSaveEvent("")).toBeUndefined();
    expect(parseSaveEvent("not json")).toBeUndefined();
    expect(parseSaveEvent('{"type":"party"}')).toBeUndefined();
  });
});

describe("folderName", () => {
  it("is the last part of a Windows or Mac/Linux path", () => {
    expect(folderName("C:\\Users\\me\\Music")).toBe("Music");
    expect(folderName("C:\\Users\\me\\Music\\")).toBe("Music");
    expect(folderName("D:\\")).toBe("D:");
    expect(folderName("/home/me/Music")).toBe("Music");
    expect(folderName("/")).toBe("/");
  });
});
