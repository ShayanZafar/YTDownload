import net from "net";
import type { RequestHandler } from "express";

/**
 * Protection against "DNS rebinding": a malicious website points its own
 * domain at 127.0.0.1 so the page can talk to servers running on your PC.
 * Browsers still send that domain in the Host header, so we only answer
 * requests addressed to this computer (localhost), to a raw IP address (e.g.
 * your PC's Wi-Fi address, typed on your phone), or to a name listed in
 * ALLOWED_HOSTS. This mirrors Vite's own dev-server rule.
 */

/** Extra host names from ALLOWED_HOSTS (comma-separated; ".example.com" allows subdomains). */
export function allowedHostsFromEnv(): string[] {
  return (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function isHostAllowed(hostHeader: string | undefined, extraHosts: string[] = []): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.trim().toLowerCase();
  // Strip the port: "[::1]:5000" → "::1", "localhost:5000" → "localhost".
  host = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d+$/, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIP(host)) return true;
  return extraHosts.some((allowed) =>
    allowed.startsWith(".")
      ? host === allowed.slice(1) || host.endsWith(allowed)
      : host === allowed,
  );
}

export function hostCheck(extraHosts: string[] = allowedHostsFromEnv()): RequestHandler {
  return (req, res, next) => {
    if (isHostAllowed(req.headers.host, extraHosts)) return next();
    res
      .status(403)
      .type("text/plain")
      .send(
        `Blocked request: "${req.headers.host}" isn't an allowed host name. ` +
          "To use this name, add it to ALLOWED_HOSTS in .env.",
      );
  };
}
