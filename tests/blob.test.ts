import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainerClient } from "@azure/storage-blob";
import { BlobSource, AccessError, NetworkError, MAX_IMAGE_BYTES, PreconditionError, imageContentType } from "../src/blob.js";
import { publishFolder } from "../src/publish.js";
import { ImageCache } from "../src/cache.js";
import { SyncEngine } from "../src/sync.js";
import { createGateway } from "../src/gateway.js";
import { GatewaySource } from "../src/gateway-client.js";
import { deviceTokenHash, parseDeviceHashes } from "../src/device-auth.js";

let server: http.Server;
let source: BlobSource;
let container: ContainerClient;
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let requests: { url: URL; ifMatch?: string }[];

const blob = (name: string, size = 3, etag = "&quot;e1&quot;") =>
  `<Blob><Name>${name}</Name><Properties><Content-Length>${size}</Content-Length><Etag>${etag}</Etag><BlobType>BlockBlob</BlobType></Properties></Blob>`;
const listing = (blobs: string, marker = "") =>
  `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${blobs}</Blobs><NextMarker>${marker}</NextMarker></EnumerationResults>`;

beforeEach(async () => {
  requests = [];
  respond = (_req, res) => { res.end(listing(blob("a.png"))); };
  server = http.createServer((req, res) => {
    requests.push({ url: new URL(req.url!, "http://localhost"), ifMatch: req.headers["if-match"] });
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("ETag", '"e1"');
    respond(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  container = new ContainerClient(`http://127.0.0.1:${port}/account/screens?sig=secret&sp=rl`, undefined, {
    retryOptions: { maxTries: 1 },
  });
  source = new BlobSource(container);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("BlobSource over the Azure Blob protocol", () => {
  it("follows continuation markers, preserves SAS and filters unsupported, nested, empty and oversized blobs", async () => {
    respond = (req, res) => {
      const marker = new URL(req.url!, "http://localhost").searchParams.get("marker");
      res.end(marker
        ? listing(blob("b.webp"))
        : listing(blob("a.PNG") + blob("sub/c.png") + blob("bad\\name.png") + blob("empty.jpg", 0) +
            blob("huge.png", MAX_IMAGE_BYTES + 1) + blob("notes.txt"), "next+page"));
    };
    expect(await source.listImages()).toEqual([
      { name: "a.PNG", size: 3, eTag: '"e1"' }, { name: "b.webp", size: 3, eTag: '"e1"' },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1].url.searchParams.get("marker")).toBe("next+page");
    expect(requests.every((req) => req.url.searchParams.get("sig") === "secret")).toBe(true);
  });

  it("encodes blob names and uses the listed ETag to avoid caching a newer upload under an old version", async () => {
    respond = (_req, res) => { res.writeHead(200, { "Content-Length": "3" }).end("img"); };
    expect((await source.download({ name: "01 # & +.png", size: 3, eTag: '"v1"' })).toString()).toBe("img");
    expect(decodeURIComponent(requests[0].url.pathname)).toBe("/account/screens/01 # & +.png");
    expect(requests[0].url.searchParams.get("sig")).toBe("secret");
    expect(requests[0].ifMatch).toBe('"v1"');
  });

  it.each([401, 403, 404, 412, 429, 503])("classifies HTTP %s without exposing SAS credentials", async (status) => {
    respond = (_req, res) => { res.writeHead(status).end("<Error><Code>Failure</Code><Message>sig=secret</Message></Error>"); };
    const type = [401, 403, 404].includes(status) ? AccessError : NetworkError;
    await expect(source.listImages()).rejects.toBeInstanceOf(type);
    await expect(source.listImages()).rejects.not.toThrow("secret");
  });

  it("rejects content with a different size than the listed version", async () => {
    respond = (_req, res) => { res.writeHead(200, { "Content-Length": "4" }).end("long"); };
    await expect(source.download({ name: "a.png", size: 3, eTag: '"e1"' })).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects truncated or oversized chunked bodies", async () => {
    for (const body of ["ab", "abcd"]) {
      const stream = Readable.from([Buffer.from(body)]);
      const corruptSource = new BlobSource({
        getBlobClient: () => ({ download: async () => ({ contentLength: 3, readableStreamBody: stream }) }),
      } as unknown as ContainerClient);
      await expect(corruptSource.download({ name: "a.png", size: 3, eTag: '"e1"' })).rejects.toBeInstanceOf(NetworkError);
      expect(stream.destroyed).toBe(true);
    }
  });

  it("maps deletes of missing or replaced blobs without exposing storage errors", async () => {
    respond = (_req, res) => { res.writeHead(404).end(); };
    expect(await source.remove("gone.png", '"v1"')).toBe(false);
    respond = (req, res) => { res.writeHead(req.headers["if-match"] === '"old"' ? 412 : 202).end(); };
    await expect(source.remove("a.png", '"old"')).rejects.toBeInstanceOf(PreconditionError);
    expect(await source.remove("a.png")).toBe(true);
  });

  it("accepts only safe image basenames", () => {
    expect(imageContentType("dashboard.JPEG")).toBe("image/jpeg");
    for (const name of ["folder/a.png", "../a.png", "a\\b.png", "a\0.png", "notes.txt", "a.constructor", "a.__proto__"]) {
      expect(imageContentType(name)).toBeUndefined();
    }
  });

  it("publishes a local folder through the gateway to Blob and on to the display cache, preserving it during storage failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "blob-transfer-"));
    const cache = new ImageCache(join(dir, "cache"));
    const token = `office.${Buffer.alloc(32, 1).toString("base64url")}`;
    const tokenFile = join(dir, "display.token");
    await writeFile(tokenFile, token, { mode: 0o600 });
    const publisherToken = `screenshot-pc.${Buffer.alloc(32, 2).toString("base64url")}`;
    const publisherFile = join(dir, "publisher.token");
    await writeFile(publisherFile, publisherToken, { mode: 0o600 });
    const gateway = createGateway(source,
      parseDeviceHashes(JSON.stringify({ office: deviceTokenHash(token) })),
      parseDeviceHashes(JSON.stringify({ "screenshot-pc": deviceTokenHash(publisherToken) })));
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    const gatewaySource = new GatewaySource(gatewayUrl, tokenFile);
    const publisher = new GatewaySource(gatewayUrl, publisherFile, fetch, "publisher");
    const engine = new SyncEngine({ source: gatewaySource, cache }, { pollSeconds: 60 });
    const remote = new Map<string, { bytes: Buffer; etag: string }>();
    let version = 0;
    respond = (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      const name = decodeURIComponent(url.pathname.split("/").at(-1)!);
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const etag = `"v${++version}"`;
          remote.set(name, { bytes: Buffer.concat(chunks), etag });
          res.writeHead(201, { ETag: etag }).end();
        });
      } else if (req.method === "DELETE") {
        remote.delete(name);
        res.writeHead(202).end();
      } else if (url.searchParams.get("comp") === "list") {
        res.end(listing([...remote].map(([key, value]) => blob(key, value.bytes.length, value.etag)).join("")));
      } else {
        const value = remote.get(name)!;
        res.writeHead(200, { "Content-Length": value.bytes.length, ETag: value.etag }).end(value.bytes);
      }
    };
    try {
      await writeFile(join(dir, "a.png"), "first");
      await writeFile(join(dir, "b.png"), "second");
      await publishFolder(publisher, dir);
      await engine.trigger();
      expect(engine.getState().images.map((image) => image.name)).toEqual(["a.png", "b.png"]);
      expect(await readFile(join(cache.liveDir, "a.png"), "utf8")).toBe("first");

      await writeFile(join(dir, "a.png"), "updated");
      await rm(join(dir, "b.png"));
      await publishFolder(publisher, dir, true);
      await engine.trigger();
      expect(engine.getState().images.map((image) => image.name)).toEqual(["a.png"]);
      expect(await readFile(join(cache.liveDir, "a.png"), "utf8")).toBe("updated");
      expect(requests.every((req) => req.url.searchParams.get("sig") === "secret")).toBe(true);

      respond = (_req, res) => { res.writeHead(403).end(); };
      await engine.trigger();
      expect(engine.getState().banner?.kind).toBe("offline");
      expect(engine.getState().images).toHaveLength(1);
      expect(new ImageCache(join(dir, "cache")).load().map((image) => image.name)).toEqual(["a.png"]);
    } finally {
      engine.stop();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
