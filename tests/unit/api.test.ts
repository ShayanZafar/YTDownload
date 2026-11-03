import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, requestJson } from "../../client/src/lib/api";
import { REFUSED_MESSAGE } from "../../server/youtube-limits";

// How the page talks to the app (client/src/lib/api.ts), with fetch played by a stand-in.

const answer = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

afterEach(() => vi.unstubAllGlobals());

describe("requestJson", () => {
  const schema = z.object({ ok: z.boolean() });

  it("sends a json body as JSON, and answers with the reply its schema checked", async () => {
    const fetch = vi.fn(async () => answer({ ok: true, extra: 1 }));
    vi.stubGlobal("fetch", fetch);
    expect(await requestJson(schema, "/api/x", { method: "POST", json: { a: 1 } })).toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledWith("/api/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("turns a refusal into an ApiError with the app's message and status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ message: "Missing YouTube link" }, { status: 400 })),
    );
    const err = await requestJson(schema, "/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ message: "Missing YouTube link", status: 400, limited: false });
  });

  it("says when YouTube refused (it's limiting this computer)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        answer({ message: REFUSED_MESSAGE, source: "youtube", limited: true }, { status: 502 }),
      ),
    );
    await expect(requestJson(schema, "/api/x")).rejects.toMatchObject({
      status: 502,
      limited: true,
    });
  });

  it("says the app needs restarting when an OK answer is a web page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer("<!doctype html>", { headers: { "Content-Type": "text/html" } })),
    );
    await expect(requestJson(schema, "/api/x")).rejects.toThrow(/needs restarting/);
  });

  it("says so when an OK answer isn't the shape the page expects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ ok: "yes" })),
    );
    await expect(requestJson(schema, "/api/x")).rejects.toThrow(/didn't expect/);
  });
});
