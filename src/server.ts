import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { SyncEngine } from "./sync.js";
import type { Config } from "./config.js";
import type { ViewState } from "./status.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

const HEARTBEAT_MS = 25_000;

function sendFile(res: http.ServerResponse, path: string, noCache: boolean): void {
  let ok = false;
  try { ok = statSync(path).isFile(); } catch { /* missing */ }
  if (!ok) { res.writeHead(404).end("Not found"); return; }
  res.writeHead(200, {
    "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
    ...(noCache ? { "Cache-Control": "no-cache" } : {}),
  });
  createReadStream(path).on("error", () => res.destroy()).pipe(res);
}

export function createServer(
  engine: Pick<SyncEngine, "getState" | "on" | "off">,
  cfg: Pick<Config, "rotationSeconds">,
  publicDir: string,
  imageDir: () => string,
): http.Server {
  return http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (state: ViewState = engine.getState()) => res.write(`data: ${JSON.stringify(state)}\n\n`);
      send();
      engine.on("state", send);
      const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
      req.on("close", () => { engine.off("state", send); clearInterval(beat); });
      return;
    }

    if (path === "/config.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rotationSeconds: cfg.rotationSeconds }));
      return;
    }

    if (path.startsWith("/images/")) {
      let name: string;
      try { name = decodeURIComponent(path.slice("/images/".length)); } catch { res.writeHead(400).end("Bad request"); return; }
      if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        res.writeHead(400).end("Bad request");
        return;
      }
      sendFile(res, join(imageDir(), name), true);
      return;
    }

    const file = path === "/" ? "index.html" : path.slice(1);
    if (file.includes("/") || file.includes("\\") || file.startsWith(".")) { res.writeHead(404).end("Not found"); return; }
    sendFile(res, join(publicDir, file), false);
  });
}
