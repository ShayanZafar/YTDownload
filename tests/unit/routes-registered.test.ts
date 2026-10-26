import { describe, expect, it } from "vitest";
import express from "express";
import { createServer } from "http";
import { api } from "../../shared/routes";
import { CALLBACK_PATH } from "../../server/spotify-sign-in";

// Every route in the API contract (shared/routes.ts) is served, once, and
// nothing else is: the route modules in server/routes/ can be moved around
// without one going missing or being added twice.

/** Each `{ method, path }` in the contract, as "GET /api/music". */
function contractRoutes(): string[] {
  const found: string[] = [];
  for (const area of Object.values(api)) {
    for (const route of Object.values(area) as { method?: string; path?: string }[]) {
      if (route.method && route.path) found.push(`${route.method} ${route.path}`);
    }
  }
  return found;
}

/** Each route the app serves, as "GET /api/music". */
function servedRoutes(app: express.Express): string[] {
  type Layer = { route?: { path: string; methods: Record<string, boolean> } };
  const stack = (app as unknown as { router: { stack: Layer[] } }).router.stack;
  return stack.flatMap(({ route }) =>
    route
      ? Object.keys(route.methods)
          .filter((method) => route.methods[method])
          .map((method) => `${method.toUpperCase()} ${route.path}`)
      : [],
  );
}

describe("the API routes", () => {
  it("serve every route in the contract once, plus Spotify's sign-in callback", async () => {
    const { registerRoutes } = await import("../../server/routes");
    const app = express();
    await registerRoutes(createServer(app), app);
    const served = servedRoutes(app);
    const expected = [...contractRoutes(), `GET ${CALLBACK_PATH}`];
    expect(new Set(served).size).toBe(served.length);
    expect([...served].sort()).toEqual([...new Set(expected)].sort());
  });
});
