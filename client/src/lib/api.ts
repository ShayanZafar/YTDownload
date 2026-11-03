/**
 * How the page talks to the app: `requestJson()` sends a request (a `json`
 * body as JSON), and answers with the reply checked against its schema from
 * shared/routes.ts or shared/schema.ts. A reply that isn't OK becomes an
 * `ApiError` with the app's own message (`errorFrom()`); an OK one that isn't
 * what the page expected becomes one too (`unexpectedAnswer()`). Every call to
 * the app goes through here, but for the few that read the reply another way
 * (a save's progress lines, a song's audio, a delete's "no bin" answer).
 */
import { z } from "zod";
import { errorSchemas } from "@shared/routes";

/** A request the app turned down, with its reason and HTTP status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** YouTube refused it: it's limiting this computer (the app says so at once, in a 502). */
    readonly limited = false,
  ) {
    super(message);
  }
}

/** The app's error for a response that wasn't OK, from its JSON body (or the status alone). */
export async function errorFrom(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => undefined);
  const limited = errorSchemas.limited.safeParse(data);
  if (limited.success) return new ApiError(limited.data.message, res.status, true);
  const parsed = errorSchemas.internal.safeParse(data);
  return new ApiError(
    parsed.success ? parsed.data.message : `Something went wrong (HTTP ${res.status}).`,
    res.status,
  );
}

/**
 * The error for an OK answer that isn't what the page expected. A web page
 * instead of JSON means the app's server doesn't know the request: it's an
 * older version than the page (updated, but not restarted).
 */
export function unexpectedAnswer(res: Response): ApiError {
  if (res.headers.get("content-type")?.includes("text/html")) {
    return new ApiError(
      "The app needs restarting: it's still running an older version than this page. Stop it and start it again, then try again.",
      res.status,
    );
  }
  return new ApiError("The app sent an answer the page didn't expect.", res.status);
}

/** Sends a request to the app and answers with its reply, checked against `schema`. */
export async function requestJson<T>(
  schema: z.ZodType<T>,
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    ...(json === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) }),
  });
  if (!res.ok) throw await errorFrom(res);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw unexpectedAnswer(res);
  return parsed.data;
}
