import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.js";
import type { ViewState } from "../src/status.js";

let server: http.Server;
let port: number;
let engine: EventEmitter & { getState(): ViewState };
let imgDir: string;

const state = (n: number): ViewState => ({ images: Array.from({ length: n }, (_, i) => ({ name: `${i}.png`, url: `/images/${i}.png` })), banner: null });

beforeEach(async () => {
  imgDir = mkdtempSync(join(tmpdir(), "img-"));
  writeFileSync(join(imgDir, "a.png"), "PNGDATA");
  let current = state(1);
  engine = Object.assign(new EventEmitter(), { getState: () => current, set: (s: ViewState) => { current = s; } });
  server = createServer(engine as any, { rotationSeconds: 7 } as any, join(process.cwd(), "public"), () => imgDir);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => { server.closeAllConnections(); server.close(); });

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    }).on("error", reject);
  });
}

async function readEvents(count: number, trigger?: () => void): Promise<ViewState[]> {
  const res = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: ViewState[] = [];
  let buf = "";
  let triggered = false;
  while (out.length < count) {
    const { value } = await reader.read();
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) out.push(JSON.parse(line.slice(6)));
    }
    if (!triggered && out.length >= 1 && trigger) { triggered = true; trigger(); }
  }
  await reader.cancel();
  return out;
}

describe("server", () => {
  it("SSE sends current state immediately", async () => {
    const [first] = await readEvents(1);
    expect(first.images).toHaveLength(1);
  });

  it("SSE sends a second event after the engine emits state", async () => {
    const events = await readEvents(2, () => engine.emit("state", state(3)));
    expect(events[1].images).toHaveLength(3);
  });

  it("serves /config.json with the rotation interval", async () => {
    expect(JSON.parse((await rawGet("/config.json")).body)).toEqual({ rotationSeconds: 7 });
  });

  it("serves the index page and an image", async () => {
    expect((await rawGet("/")).status).toBe(200);
    expect(await rawGet("/images/a.png")).toEqual({ status: 200, body: "PNGDATA" });
  });

  it("rejects path traversal on /images with 400", async () => {
    expect((await rawGet("/images/../secret")).status).toBe(400);
    expect((await rawGet("/images/%2e%2e%2fsecret")).status).toBe(400);
  });

  it("returns 404 for an unknown image and unknown static file", async () => {
    expect((await rawGet("/images/missing.png")).status).toBe(404);
    expect((await rawGet("/nope.js")).status).toBe(404);
  });

  it("survives a file that cannot be opened after it was found", async () => {
    writeFileSync(join(imgDir, "locked.png"), "x");
    chmodSync(join(imgDir, "locked.png"), 0o000);
    await rawGet("/images/locked.png").catch(() => undefined);
    expect((await rawGet("/images/a.png")).status).toBe(200);
  });
});
