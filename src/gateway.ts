import http from "node:http";
import { authenticateDevice } from "./device-auth.js";
import { MAX_IMAGE_BYTES, PreconditionError, imageContentType, type ImageStore } from "./source.js";

const MAX_ACTIVE_REQUESTS = 4;
// Uploads are buffered in memory before reaching storage; one at a time keeps a small replica safe.
const MAX_ACTIVE_UPLOADS = 1;

type Role = "display" | "publisher";

function readBody(req: http.IncomingMessage, expected: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > expected) {
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(received === expected ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

/**
 * The only component with storage access. Displays (device tokens) may list and download;
 * publishers (publisher tokens) may also upload and delete. Nothing else is exposed.
 */
export function createGateway(
  store: ImageStore,
  devices: ReadonlyMap<string, Buffer>,
  publishers: ReadonlyMap<string, Buffer> = new Map(),
): http.Server {
  let active = 0;
  let uploads = 0;
  return http.createServer({ requestTimeout: 120_000, headersTimeout: 15_000, maxHeaderSize: 8_192 }, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, message: string) => {
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
    };
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    const role: Role | undefined = authenticateDevice(req.headers.authorization, publishers) ? "publisher"
      : authenticateDevice(req.headers.authorization, devices) ? "display" : undefined;
    if (!role) {
      res.setHeader("WWW-Authenticate", "Bearer");
      send(401, "Device or publisher credential required");
      return;
    }
    const method = req.method ?? "";
    const allowed = role === "publisher" ? ["GET", "PUT", "DELETE"] : ["GET"];
    if (!allowed.includes(method)) {
      res.setHeader("Allow", allowed.join(", "));
      send(role === "display" && ["PUT", "DELETE"].includes(method) ? 403 : 405,
        role === "display" ? "Displays have read-only access" : "Method not allowed");
      return;
    }

    let name: string | undefined;
    if (req.url !== "/v1/images") {
      const match = /^\/v1\/images\/([^/?]+)$/.exec(req.url ?? "");
      if (!match) { send(404, "Not found"); return; }
      try { name = decodeURIComponent(match[1]); } catch { send(400, "Invalid image name"); return; }
      if (!imageContentType(name)) { send(400, "Invalid image name"); return; }
    } else if (method !== "GET") {
      send(405, "Method not allowed");
      return;
    }

    let size = 0;
    if (method === "GET" && name !== undefined && !req.headers["if-match"]) { send(428, "If-Match required"); return; }
    if (method === "PUT") {
      const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== imageContentType(name!)) { send(415, "Content-Type must match the image extension"); return; }
      size = Number(req.headers["content-length"]);
      if (!Number.isSafeInteger(size) || size <= 0) { send(411, "Content-Length required"); return; }
      if (size > MAX_IMAGE_BYTES) { send(413, "Images are limited to 50 MiB"); return; }
    }

    if (active >= MAX_ACTIVE_REQUESTS || (method === "PUT" && uploads >= MAX_ACTIVE_UPLOADS)) {
      res.setHeader("Retry-After", "5");
      send(503, "Gateway busy");
      return;
    }
    active++;
    if (method === "PUT") uploads++;
    // Keep buffered transfers bounded even when a client is slow or disconnects.
    let finished = false;
    let closed = false;
    const release = () => {
      if (finished && closed) {
        active--;
        if (method === "PUT") uploads--;
      }
    };
    res.once("close", () => { closed = true; release(); });
    res.setTimeout(120_000, () => res.destroy());

    void (async () => {
      try {
        if (method === "PUT") {
          const data = await readBody(req, size);
          if (!data) { if (!res.destroyed) send(400, "Body didn't match Content-Length"); return; }
          const eTag = await store.upload(name!, data, imageContentType(name!)!);
          if (!res.destroyed) {
            res.writeHead(201, { "Content-Type": "application/json", ETag: eTag })
              .end(JSON.stringify({ name, eTag, size }));
          }
          return;
        }
        if (method === "DELETE") {
          const ifMatch = req.headers["if-match"];
          const removed = await store.remove(name!, typeof ifMatch === "string" ? ifMatch : undefined);
          if (!res.destroyed) {
            if (removed) res.writeHead(204).end();
            else send(404, "Image not found");
          }
          return;
        }
        const images = await store.listImages();
        if (res.destroyed) return;
        if (name === undefined) {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(images));
          return;
        }
        const image = images.find((entry) => entry.name === name);
        if (!image) { send(404, "Image not found"); return; }
        if (req.headers["if-match"] !== image.eTag) { send(412, "Image changed; refresh the listing"); return; }
        const bytes = await store.download(image);
        if (res.destroyed) return;
        res.writeHead(200, {
          "Content-Type": imageContentType(image.name)!,
          "Content-Length": bytes.length,
          ETag: image.eTag,
        }).end(bytes);
      } catch (error) {
        if (res.destroyed) return;
        if (error instanceof PreconditionError) send(412, "Image changed; refresh the listing");
        else send(503, "Image storage temporarily unavailable");
      } finally {
        finished = true;
        release();
      }
    })();
  });
}
