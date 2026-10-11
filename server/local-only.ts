import type { Request, RequestHandler } from "express";

/**
 * Guards for the routes that touch this computer's files (the "Save to"
 * folder, the folder browser, saving a download into the folder):
 *
 * - Only a browser on this computer may use them. With HOST=0.0.0.0 a phone on
 *   your Wi-Fi can use the app too, but it can't browse or write your folders.
 * - Only this app's own page may use them. Any website you visit could send
 *   requests to http://localhost:5000; browsers label those as cross-site
 *   (Sec-Fetch-Site, Origin), so they're refused.
 */

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Did the request come from this computer? Not if it was passed on by a proxy
 * or tunnel running here (they add X-Forwarded-For or similar): then it really
 * came from somewhere else.
 */
export function isLocalRequest(req: Pick<Request, "socket" | "headers">): boolean {
  const { headers } = req;
  if (headers["x-forwarded-for"] || headers.forwarded || headers["x-real-ip"]) return false;
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

/** Did it come from this app's own page (not another website)? */
export function isSameOriginRequest(req: Pick<Request, "headers">): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== req.headers.host) return false;
    } catch {
      return false; // "null" or garbage
    }
  }
  return true;
}

const NOT_LOCAL =
  "Saving into a folder only works in a browser on the computer running the app. Here, use the normal download.";

/** `notLocal`: what to tell a browser on another device. */
export function localOnly(notLocal = NOT_LOCAL): RequestHandler {
  return (req, res, next) => {
    if (!isLocalRequest(req)) {
      return res.status(403).json({ message: notLocal });
    }
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ message: "Only this app's own page can do that." });
    }
    // Changes must be sent as JSON: a plain form on another website can't send
    // that, so even a browser too old to send the headers above can't be used
    // to change anything here.
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json")) {
      return res.status(415).json({ message: "Send the request as JSON." });
    }
    next();
  };
}

/**
 * For changes any device using the app may make (the download history): only
 * this app's own page may make them, sent as JSON when they carry a body, but
 * from any device — the history is shared by everyone using the app, like
 * the downloads themselves.
 */
export function sameOriginOnly(): RequestHandler {
  return (req, res, next) => {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ message: "Only this app's own page can do that." });
    }
    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({ message: "Send the request as JSON." });
    }
    next();
  };
}
