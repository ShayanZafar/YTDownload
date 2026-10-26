// Types for scripts/yt-dlp.mjs (plain JavaScript, so it runs straight after npm install).
type Fetch = (url: string) => Promise<Response>;
export function standaloneBuild(platform: string, arch: string, glibc: boolean): string | undefined;
export function releaseName(platform: string, arch: string, glibc: boolean): string;
export function parseSums(text: string): Map<string, string>;
export function sha256Of(file: string): Promise<string>;
export function fetchSums(fetchImpl?: Fetch): Promise<Map<string, string> | undefined>;
export function downloadChecked(
  file: string,
  name: string,
  sums: Map<string, string>,
  fetchImpl?: Fetch,
): Promise<void>;
export function checkInstalled(
  file: string,
  name: string,
  sums: Map<string, string> | undefined,
  fetchImpl?: Fetch,
): Promise<"ok" | "replaced" | "unchecked">;
export function isPythonScript(firstBytes: Uint8Array): boolean;
