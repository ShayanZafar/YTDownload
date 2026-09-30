import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { isLocalRequest, isSameOriginRequest, localOnly } from "../../server/local-only";

type FakeRequest = {
  method?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
};

const request = ({ method = "GET", headers = {}, ...rest }: FakeRequest) =>
  ({
    method,
    headers: { host: "localhost:5000", ...headers },
    socket: { remoteAddress: "remoteAddress" in rest ? rest.remoteAddress : "127.0.0.1" },
    is: (type: string) => ((headers["content-type"] ?? "").startsWith(type) ? type : false),
  }) as unknown as Request;

describe("isLocalRequest", () => {
  it("accepts this computer, over IPv4 or IPv6", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLocalRequest(request({ remoteAddress }))).toBe(true);
    }
  });

  it("refuses other devices, and anything passed on by a proxy or tunnel", () => {
    expect(isLocalRequest(request({ remoteAddress: "192.168.1.20" }))).toBe(false);
    expect(isLocalRequest(request({ remoteAddress: undefined }))).toBe(false);
    expect(isLocalRequest(request({ headers: { "x-forwarded-for": "203.0.113.9" } }))).toBe(false);
    expect(isLocalRequest(request({ headers: { forwarded: "for=203.0.113.9" } }))).toBe(false);
  });
});

describe("isSameOriginRequest", () => {
  it("accepts the app's own page, and requests without browser headers", () => {
    expect(isSameOriginRequest(request({}))).toBe(true);
    expect(isSameOriginRequest(request({ headers: { "sec-fetch-site": "same-origin" } }))).toBe(
      true,
    );
    expect(isSameOriginRequest(request({ headers: { "sec-fetch-site": "none" } }))).toBe(true);
    expect(isSameOriginRequest(request({ headers: { origin: "http://localhost:5000" } }))).toBe(
      true,
    );
  });

  it("refuses other websites", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(isSameOriginRequest(request({ headers: { "sec-fetch-site": site } }))).toBe(false);
    }
    for (const origin of ["https://evil.example", "http://localhost:5001", "null"]) {
      expect(isSameOriginRequest(request({ headers: { origin } }))).toBe(false);
    }
  });
});

describe("localOnly", () => {
  const run = (req: Request) => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    localOnly()(req, res as unknown as Response, next);
    return { status: res.status.mock.calls[0]?.[0], next: next.mock.calls.length > 0 };
  };

  it("lets the app's own page on this computer through", () => {
    expect(run(request({})).next).toBe(true);
    const json = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
    expect(run(request({ method: "PUT", headers: json })).next).toBe(true);
  });

  it("turns away other devices and other websites", () => {
    expect(run(request({ remoteAddress: "10.0.0.5" }))).toEqual({ status: 403, next: false });
    expect(run(request({ headers: { "sec-fetch-site": "cross-site" } }))).toEqual({
      status: 403,
      next: false,
    });
  });

  it("only takes changes sent as JSON", () => {
    expect(run(request({ method: "POST", headers: { "content-type": "text/plain" } }))).toEqual({
      status: 415,
      next: false,
    });
  });
});
