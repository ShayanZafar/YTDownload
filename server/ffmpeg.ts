/**
 * Running ffmpeg on its own (the download pipeline, yt-dlp piped into ffmpeg,
 * is audio.ts's). Every feature that runs ffmpeg once — the player's FLAC
 * conversions, Trim's waveform and cut, Housekeeping's check, Fill in details'
 * probe and write, covers — goes through `ffmpeg()`, so a timeout, Stop, and
 * what its errors say work the same everywhere.
 */
import type { ChildProcess } from "child_process";
import { spawnFfmpeg } from "./audio";

export type FfmpegOptions = {
  /** Fed to ffmpeg's input (`pipe:0`); otherwise its input is closed at once. */
  input?: Buffer;
  /** Stops ffmpeg after this long. */
  timeoutMs?: number;
  /** Stops ffmpeg when this gives up. */
  signal?: AbortSignal;
  /** Each piece of ffmpeg's output as it comes; without it, the output is kept whole. */
  onStdout?: (chunk: Buffer) => void;
  /** How much of what ffmpeg prints to keep: its last (default) or first `chars`. */
  stderr?: { keep: "last" | "first"; chars: number };
  /** Gets the process once it's started (to stop it from elsewhere). */
  onStart?: (child: ChildProcess) => void;
};

/** How an ffmpeg run ended. */
export type FfmpegResult = {
  code: number | null;
  /** The signal that stopped it (a timeout, Stop, or `kill()`). */
  killedBy: NodeJS.Signals | null;
  /** Its output, unless `onStdout` took it. */
  stdout: Buffer;
  stderr: string;
  /** Whether `signal` gave up. */
  aborted: boolean;
};

const DEFAULT_STDERR = { keep: "last", chars: 4000 } as const;
/** How long ffmpeg has to stop when asked, before it's stopped outright. */
const KILL_AFTER_MS = 2_000;

/**
 * Runs ffmpeg with `args` and answers with how it ended, whatever its exit
 * code. Rejects only if ffmpeg can't be started at all.
 */
export function ffmpeg(args: string[], options: FfmpegOptions = {}): Promise<FfmpegResult> {
  const { input, timeoutMs, signal, onStdout, onStart } = options;
  const { keep, chars } = options.stderr ?? DEFAULT_STDERR;
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(args);
    onStart?.(child);
    // ffmpeg can ignore a polite stop on macOS and Linux (it does in a Linux container, part-way
    // through reading): it's stopped outright if it hasn't gone a moment later.
    const running = () => child.exitCode === null && child.signalCode === null;
    const stop = () => {
      if (!running()) return;
      child.kill();
      setTimeout(() => running() && child.kill("SIGKILL"), KILL_AFTER_MS).unref();
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    };

    const output: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (onStdout ? onStdout(chunk) : output.push(chunk)));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keep === "last" ? (stderr + chunk).slice(-chars) : (stderr + chunk).slice(0, chars);
    });
    // ffmpeg may stop reading its input early.
    child.stdin.on("error", () => {});
    child.stdin.end(input);

    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code, killedBy) => {
      done();
      resolve({
        code,
        killedBy,
        stdout: Buffer.concat(output),
        stderr,
        aborted: signal?.aborted ?? false,
      });
    });
  });
}

/** Why an ffmpeg run failed: its last error line, else how it stopped. */
export function ffmpegFailure({ code, killedBy, stderr }: FfmpegResult): string {
  const lastLine = stderr.trim().split(/\r?\n/).pop();
  return lastLine || `ffmpeg stopped (${killedBy ?? `exit code ${code}`})`;
}

/** The longest a conversion may take (a whole audiobook takes a few minutes). */
const CONVERSION_TIMEOUT_MS = 30 * 60_000;

/** Runs ffmpeg; rejects with its last error line if it fails. `onStart` gets the process. */
export async function runFfmpeg(
  args: string[],
  onStart?: (child: ChildProcess) => void,
): Promise<void> {
  // ffmpeg writes the file itself: its own output is nothing to keep.
  const result = await ffmpeg(args, {
    timeoutMs: CONVERSION_TIMEOUT_MS,
    onStart,
    onStdout: () => {},
  });
  if (result.code !== 0) throw new Error(ffmpegFailure(result));
}
