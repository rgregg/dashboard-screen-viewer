import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type http from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGateway } from "../src/gateway.js";
import { GatewaySource } from "../src/gateway-client.js";
import { deviceTokenHash, parseDeviceHashes } from "../src/device-auth.js";
import { AccessError, NetworkError, PreconditionError, type RemoteImage } from "../src/source.js";

const token = `office-screen.${Buffer.alloc(32, 7).toString("base64url")}`;
const publisherToken = `screenshot-pc.${Buffer.alloc(32, 9).toString("base64url")}`;
const image: RemoteImage = { name: "01 # & +.png", size: 3, eTag: '"v1"' };
let dir: string;
let tokenFile: string;
let server: http.Server;
let url: string;
let source: {
  listImages: ReturnType<typeof vi.fn<() => Promise<RemoteImage[]>>>;
  download: ReturnType<typeof vi.fn<(image: RemoteImage) => Promise<Buffer>>>;
  upload: ReturnType<typeof vi.fn<(name: string, data: Buffer, contentType: string) => Promise<string>>>;
  remove: ReturnType<typeof vi.fn<(name: string, eTag?: string) => Promise<boolean>>>;
};
let publisherFile: string;
let devices: Map<string, Buffer>;
let client: GatewaySource;

const auth = { Authorization: `Bearer ${token}` };
const imagePath = () => `/v1/images/${encodeURIComponent(image.name)}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gateway-"));
  tokenFile = join(dir, "display.token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  devices = parseDeviceHashes(JSON.stringify({ "office-screen": deviceTokenHash(token) }));
  source = {
    listImages: vi.fn(async () => [image]),
    download: vi.fn(async (_image: RemoteImage) => Buffer.from("img")),
    upload: vi.fn(async (_name: string, _data: Buffer, _type: string) => '"v2"'),
    remove: vi.fn(async (_name: string, _eTag?: string) => true),
  };
  publisherFile = join(dir, "publisher.token");
  await writeFile(publisherFile, publisherToken, { mode: 0o600 });
  const publishers = parseDeviceHashes(JSON.stringify({ "screenshot-pc": deviceTokenHash(publisherToken) }));
  server = createGateway(source, devices, publishers);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = new GatewaySource(url, tokenFile);
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe("read-only download gateway", () => {
  it("only exposes health without a valid device credential", async () => {
    expect(await (await fetch(`${url}/healthz`)).text()).toBe("ok");
    for (const authorization of [undefined, "Bearer invalid", `Bearer unknown.${"a".repeat(43)}`, `Bearer office-screen.${"a".repeat(43)}`]) {
      const response = await fetch(`${url}/v1/images`, { headers: authorization ? { Authorization: authorization } : {} });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(source.listImages).not.toHaveBeenCalled();
  });

  it("lists and transfers an exact image version with an encoded filename", async () => {
    expect(await client.listImages()).toEqual([image]);
    expect(await client.download(image)).toEqual(Buffer.from("img"));
    expect(source.download).toHaveBeenCalledExactlyOnceWith(image);
  });

  it("rejects writes from displays, unsafe paths, missing version conditions and stale versions", async () => {
    for (const method of ["PUT", "DELETE"]) {
      expect((await fetch(`${url}${imagePath()}`, { method, headers: { ...auth, "Content-Type": "image/png" }, body: method === "PUT" ? "img" : undefined })).status).toBe(403);
    }
    for (const method of ["POST", "PATCH"]) {
      expect((await fetch(`${url}/v1/images`, { method, headers: auth })).status).toBe(405);
    }
    expect(source.upload).not.toHaveBeenCalled();
    expect(source.remove).not.toHaveBeenCalled();
    for (const path of ["/v1/images/folder%2Fa.png", "/v1/images/bad%5Cname.png", "/v1/images/%ZZ.png", "/v1/images/file.txt"]) {
      expect((await fetch(`${url}${path}`, { headers: auth })).status).toBe(400);
    }
    expect((await fetch(`${url}${imagePath()}`, { headers: auth })).status).toBe(428);
    expect((await fetch(`${url}${imagePath()}`, { headers: { ...auth, "If-Match": '"old"' } })).status).toBe(412);
    expect((await fetch(`${url}/v1/images/missing.png`, { headers: { ...auth, "If-Match": '"v1"' } })).status).toBe(404);
    expect((await fetch(`${url}/v1/images?token=not-accepted`)).status).toBe(401);
    expect(source.download).not.toHaveBeenCalled();
  });

  it("does not mistake storage authorization errors for a revoked device or expose SDK details", async () => {
    source.listImages.mockRejectedValue(new AccessError("https://storage.example?sig=secret"));
    const response = await fetch(`${url}/v1/images`, { headers: auth });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    await expect(client.listImages()).rejects.toBeInstanceOf(NetworkError);
  });

  it("bounds in-flight requests even when their clients disconnect", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    source.listImages.mockImplementation(async () => { await pending; return [image]; });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const requests = controllers.map((controller) =>
      fetch(`${url}/v1/images`, { headers: auth, signal: controller.signal }).catch(() => undefined));
    try {
      await vi.waitFor(() => expect(source.listImages).toHaveBeenCalledTimes(4));
      controllers.forEach((controller) => controller.abort());
      await Promise.all(requests);
      expect((await fetch(`${url}/v1/images`, { headers: auth })).status).toBe(503);
      expect(source.listImages).toHaveBeenCalledTimes(4);
    } finally {
      release();
    }
  });
});

describe("publisher access through the gateway", () => {
  const publisher = () => new GatewaySource(url, publisherFile, fetch, "publisher");
  const pubAuth = { Authorization: `Bearer ${publisherToken}` };

  it("uploads and deletes images with a publisher token, and can also read", async () => {
    await publisher().upload(image.name, Buffer.from("new"), "image/png");
    expect(source.upload).toHaveBeenCalledExactlyOnceWith(image.name, Buffer.from("new"), "image/png");
    expect(await publisher().listImages()).toEqual([image]);
    await publisher().remove(image.name, '"v1"');
    expect(source.remove).toHaveBeenCalledExactlyOnceWith(image.name, '"v1"');
  });

  it("validates uploads before touching storage", async () => {
    const put = (path: string, headers: Record<string, string>, body?: string) =>
      fetch(`${url}${path}`, { method: "PUT", headers: { ...pubAuth, ...headers }, body });
    expect((await put(imagePath(), { "Content-Type": "image/jpeg" }, "img")).status).toBe(415);
    expect((await put("/v1/images/notes.txt", { "Content-Type": "text/plain" }, "x")).status).toBe(400);
    expect((await put("/v1/images", { "Content-Type": "image/png" }, "x")).status).toBe(405);
    // fetch can't declare a Content-Length, so send the oversized upload's headers directly.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${url}${imagePath()}`, {
        method: "PUT",
        headers: { ...pubAuth, "Content-Type": "image/png", "Content-Length": 51 * 1024 * 1024 },
      }, (res) => { res.resume(); resolve(res.statusCode!); req.destroy(); });
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(source.upload).not.toHaveBeenCalled();
  });

  it("reports deletes of missing or replaced images", async () => {
    source.remove.mockResolvedValueOnce(false);
    await publisher().remove("gone.png", '"v1"');
    source.remove.mockRejectedValueOnce(new PreconditionError());
    await expect(publisher().remove(image.name, '"old"')).rejects.toBeInstanceOf(PreconditionError);
  });

  it("rejects a revoked publisher token as an access problem", async () => {
    await writeFile(publisherFile, `screenshot-pc.${Buffer.alloc(32, 1).toString("base64url")}`);
    await expect(publisher().upload(image.name, Buffer.from("x"), "image/png")).rejects.toThrow(/publisher token/);
  });
});

describe("gateway viewer client", () => {
  it("detects revocation and reloads a replacement credential without restarting the viewer", async () => {
    devices.clear();
    await expect(client.listImages()).rejects.toBeInstanceOf(AccessError);
    const replacement = `office-screen.${Buffer.alloc(32, 8).toString("base64url")}`;
    devices.set("office-screen", Buffer.from(deviceTokenHash(replacement), "hex"));
    await writeFile(tokenFile, replacement);
    expect(await client.listImages()).toEqual([image]);
  });

  it("treats a missing or malformed credential file as an access problem", async () => {
    await rm(tokenFile);
    await expect(client.listImages()).rejects.toBeInstanceOf(AccessError);
    await writeFile(tokenFile, "invalid secret");
    await expect(client.listImages()).rejects.not.toThrow("secret");
    expect(source.listImages).not.toHaveBeenCalled();
  });

  it.each([
    null,
    [{ ...image, name: "../a.png" }],
    [{ ...image, size: -1 }],
    [{ ...image, eTag: "" }],
    [{ ...image, eTag: "header\r\ninjection" }],
    [image, image],
  ].map((manifest) => ({ manifest })))("rejects an invalid manifest: $manifest", async ({ manifest }) => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(manifest)));
    await expect(new GatewaySource(url, tokenFile, fetchFn).listImages()).rejects.toBeInstanceOf(NetworkError);
  });

  it("bounds manifest and image bodies and rejects the wrong ETag", async () => {
    const responses = [
      new Response(Buffer.alloc(1024 * 1024 + 1)),
      new Response("img", { headers: { ETag: '"wrong"' } }),
      new Response("oversized", { headers: { ETag: image.eTag } }),
      new Response("ab", { headers: { ETag: image.eTag } }),
    ];
    const fetchFn = vi.fn(async () => responses.shift()!);
    const invalid = new GatewaySource(url, tokenFile, fetchFn);
    await expect(invalid.listImages()).rejects.toBeInstanceOf(NetworkError);
    for (let i = 0; i < 3; i++) await expect(invalid.download(image)).rejects.toBeInstanceOf(NetworkError);
  });

  it("uses header authentication only and forbids redirects", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify([image])));
    await new GatewaySource(url, tokenFile, fetchFn).listImages();
    expect(fetchFn).toHaveBeenCalledWith(`${url}/v1/images`, expect.objectContaining({
      headers: auth,
      redirect: "error",
    }));
    expect(await readFile(tokenFile, "utf8")).toContain(token);
  });
});
