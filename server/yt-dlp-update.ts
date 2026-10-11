/**
 * Updating yt-dlp from inside the app. YouTube changes its pages every few
 * weeks and yt-dlp stops understanding them until it's updated ("Unable to
 * extract…", "Requested format is not available"); an outdated yt-dlp also
 * earns "Sign in to confirm you're not a bot" more easily. So when a yt-dlp
 * call fails that way, the app runs the repo's own updater — what `npm run
 * update-yt-dlp` runs, `node scripts/yt-dlp.mjs --update` — once an hour at
 * most, and the call that failed is tried once more (see youtube-limits.ts).
 */
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";

/** yt-dlp is updated by the app at most this often… */
export const UPDATE_EVERY_MS = 60 * 60_000;
/** …and an update is given this long. */
export const UPDATE_TIMEOUT_MS = 2 * 60_000;

export type UpdateOutcome = { ok: boolean; detail: string };

/**
 * Runs the updater — Node itself (`process.execPath`), never a shell — and
 * says whether it worked. It can't fail loudly: no network, no permission to
 * replace the file, or no script (an odd install) just mean "no".
 */
export async function runYtDlpUpdateScript(
  script = path.resolve(process.cwd(), "scripts", "yt-dlp.mjs"),
  timeoutMs = UPDATE_TIMEOUT_MS,
): Promise<UpdateOutcome> {
  try {
    await fs.access(script);
  } catch {
    return { ok: false, detail: `${path.basename(script)} isn't there` };
  }
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(process.execPath, [script, "--update"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
    const keep = (chunk: Buffer | string) => (output = (output + chunk).slice(-4000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const lastLine = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
      resolve({
        ok: code === 0,
        detail: lastLine || (code === null ? "it took too long" : `exit code ${code}`),
      });
    });
  });
}

/**
 * Updates yt-dlp at most once an hour, logging one line when it starts and one
 * when it's done. Callers that ask during an update share it.
 */
export class YtDlpUpdater {
  private lastAt: number | undefined;
  private inFlight: Promise<boolean> | undefined;

  constructor(
    private readonly run: () => Promise<UpdateOutcome> = () => runYtDlpUpdateScript(),
    private readonly log: (line: string) => void = console.log,
  ) {}

  /** Is it time for another update? (Not if one ran — or was tried — in the last hour.) */
  due(now: number): boolean {
    return this.lastAt === undefined || now - this.lastAt >= UPDATE_EVERY_MS;
  }

  /**
   * Updates yt-dlp if it's due (`reason`: the error that calls for it), and
   * resolves true if it updated — so the failed call is worth trying again.
   * A failed update (no network, say) counts as this hour's try: the app
   * carries on with yt-dlp as it is.
   */
  update(now: number, reason: string): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    if (!this.due(now)) return Promise.resolve(false);
    this.lastAt = now;
    this.log(`yt-dlp: YouTube answered "${reason}" — updating yt-dlp, then trying once more.`);
    this.inFlight = this.run()
      .then(
        (outcome) => outcome,
        (err): UpdateOutcome => ({
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        }),
      )
      .then(({ ok, detail }) => {
        this.log(
          ok
            ? `yt-dlp: updated (${detail}).`
            : `yt-dlp: couldn't update (${detail}) — carrying on with the one installed.`,
        );
        return ok;
      })
      .finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  /** Forgets the last update (tests). */
  forget(): void {
    this.lastAt = undefined;
  }
}
