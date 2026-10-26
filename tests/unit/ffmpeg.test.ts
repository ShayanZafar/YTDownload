import { describe, expect, it } from "vitest";
import { ffmpeg, ffmpegFailure, runFfmpeg } from "../../server/ffmpeg";

// A second of silence as raw 8 kHz mono samples: 16,000 bytes on ffmpeg's output.
const SILENCE = [
  ...["-hide_banner", "-loglevel", "error", "-nostdin"],
  ...["-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1"],
  ...["-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
];
// Endless silence, at playing speed (-re), for stopping ffmpeg part-way.
const ENDLESS = [
  ...["-hide_banner", "-loglevel", "error", "-nostdin"],
  ...["-re", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono"],
  ...["-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"],
];

describe("ffmpeg()", () => {
  it("keeps the output whole and says how it ended", async () => {
    const result = await ffmpeg(SILENCE);
    expect(result).toMatchObject({ code: 0, killedBy: null, aborted: false });
    expect(result.stdout.length).toBe(16_000);
  });

  it("hands the output over as it comes, keeping none", async () => {
    let bytes = 0;
    const result = await ffmpeg(SILENCE, { onStdout: (chunk) => (bytes += chunk.length) });
    expect(bytes).toBe(16_000);
    expect(result.stdout.length).toBe(0);
  });

  it("feeds `input` to ffmpeg", async () => {
    const pcm = Buffer.alloc(8_000);
    const { code, stdout } = await ffmpeg(
      [
        ...["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "8000", "-ac", "1"],
        ...["-i", "pipe:0", "-f", "s16le", "pipe:1"],
      ],
      { input: pcm },
    );
    expect(code).toBe(0);
    expect(stdout.equals(pcm)).toBe(true);
  });

  it("answers a failure with its exit code and ffmpeg's last error line", async () => {
    const result = await ffmpeg(["-hide_banner", "-nostdin", "-i", "/no/such/song.mp3"]);
    expect(result.code).not.toBe(0);
    expect(ffmpegFailure(result)).toMatch(/No such file or directory/);
  });

  it("keeps the first or the last of what ffmpeg prints", async () => {
    const args = ["-hide_banner", "-nostdin", "-i", "/no/such/song.mp3"];
    const whole = (await ffmpeg(args, { stderr: { keep: "last", chars: 100_000 } })).stderr;
    expect(whole.length).toBeGreaterThan(10);
    const first = (await ffmpeg(args, { stderr: { keep: "first", chars: 5 } })).stderr;
    const last = (await ffmpeg(args, { stderr: { keep: "last", chars: 5 } })).stderr;
    expect(first).toBe(whole.slice(0, 5));
    expect(last).toBe(whole.slice(-5));
  });

  it("stops after `timeoutMs`", async () => {
    const result = await ffmpeg(ENDLESS, { timeoutMs: 200, onStdout: () => {} });
    expect(result.code === null || result.code !== 0).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("stops when the signal gives up, even before it started", async () => {
    const controller = new AbortController();
    const running = ffmpeg(ENDLESS, { signal: controller.signal, onStdout: () => {} });
    setTimeout(() => controller.abort(), 100);
    expect((await running).aborted).toBe(true);
    expect(
      (await ffmpeg(ENDLESS, { signal: AbortSignal.abort(), onStdout: () => {} })).aborted,
    ).toBe(true);
  });

  it("gives `onStart` the process", async () => {
    let pid: number | undefined;
    await ffmpeg(SILENCE, { onStart: (child) => (pid = child.pid) });
    expect(pid).toBeGreaterThan(0);
  });
});

describe("ffmpegFailure()", () => {
  it("says how ffmpeg stopped when it printed nothing", () => {
    const result = { stdout: Buffer.alloc(0), stderr: "", aborted: false };
    expect(ffmpegFailure({ ...result, code: 1, killedBy: null })).toBe(
      "ffmpeg stopped (exit code 1)",
    );
    expect(ffmpegFailure({ ...result, code: null, killedBy: "SIGTERM" })).toBe(
      "ffmpeg stopped (SIGTERM)",
    );
  });
});

describe("runFfmpeg()", () => {
  it("resolves when ffmpeg succeeds, and rejects with its last error line when not", async () => {
    await expect(runFfmpeg(SILENCE)).resolves.toBeUndefined();
    await expect(
      runFfmpeg(["-hide_banner", "-nostdin", "-i", "/no/such/song.mp3"]),
    ).rejects.toThrow(/No such file or directory/);
  });
});
