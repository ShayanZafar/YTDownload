import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { hostCheck, isHostAllowed } from "../../server/host-check";

describe("isHostAllowed", () => {
  it.each([
    "localhost",
    "localhost:5000",
    "app.localhost:5000",
    "127.0.0.1:5000",
    "192.168.1.20:5000",
    "[::1]:5000",
    "LOCALHOST:5000",
  ])("allows %s", (host) => {
    expect(isHostAllowed(host)).toBe(true);
  });

  it.each([
    "evil.example.com",
    "evil.example.com:5000",
    "localhost.evil.com",
    "127.0.0.1.nip.io",
    "",
    undefined,
  ])("blocks %s", (host) => {
    expect(isHostAllowed(host)).toBe(false);
  });

  it("allows names listed in ALLOWED_HOSTS, and subdomains with a leading dot", () => {
    expect(isHostAllowed("my-pc.tail1234.ts.net:5000", ["my-pc.tail1234.ts.net"])).toBe(true);
    expect(isHostAllowed("other-pc.tail1234.ts.net", ["my-pc.tail1234.ts.net"])).toBe(false);
    expect(isHostAllowed("my-pc.tail1234.ts.net", [".tail1234.ts.net"])).toBe(true);
    expect(isHostAllowed("tail1234.ts.net.evil.com", [".tail1234.ts.net"])).toBe(false);
  });
});

describe("hostCheck middleware", () => {
  const app = express();
  app.use(hostCheck([]));
  app.get("/ping", (_req, res) => res.send("pong"));

  it("lets local requests through", async () => {
    const res = await request(app).get("/ping").set("Host", "localhost:5000");
    expect(res.status).toBe(200);
  });

  it("refuses requests for other host names with 403", async () => {
    const res = await request(app).get("/ping").set("Host", "attacker.example");
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/ALLOWED_HOSTS/);
  });
});
