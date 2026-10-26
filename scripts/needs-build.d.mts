// Types for scripts/needs-build.mjs (plain JavaScript, so the start scripts run it with plain Node).
export const BUILD_SOURCES: { folders: string[]; files: string[] };
export const BUILT_FILE: string;
export function needsBuild(root: string): Promise<boolean>;
