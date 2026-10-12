import "./env";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { hostCheck } from "./host-check";

/** What an error handed to Express's error handler may carry. */
type HttpError = Error & { status?: number; statusCode?: number };

const app = express();
const httpServer = createServer(app);

// First thing: refuse requests addressed to unknown host names (see host-check.ts).
app.use(hostCheck());

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // Undo after clearing the history sends the whole history back (≤1,000 entries).
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: unknown = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        // A taste of the response, not all of it — the history alone can be
        // hundreds of KB, and the page refreshes it every few seconds.
        const body = JSON.stringify(capturedJsonResponse);
        logLine += ` :: ${body.length > 200 ? `${body.slice(0, 199)}…` : body}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: HttpError, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // One port serves both the API and the client. Listens on this machine only
  // by default; set HOST=0.0.0.0 to expose it to your network or a container.
  // (No `reusePort` here: it only works on Linux and makes listen() fail with
  // ENOTSUP on Windows and macOS.)
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "127.0.0.1";
  httpServer.listen({ port, host }, () => {
    const shown = host === "0.0.0.0" || host === "127.0.0.1" ? "localhost" : host;
    log(`serving on http://${shown}:${port}`);
  });
})();
