import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPublishConfig, publishFolder, type PublishTarget } from "../src/publish.js";
import { AccessError, PreconditionError, type RemoteImage } from "../src/source.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "publish-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function setup(remote: string[] = ["old.png", "keep.png"]) {
  const target = {
    listImages: vi.fn(async (): Promise<RemoteImage[]> => remote.map((name) => ({ name, eTag: `"${name}"`, size: 3 }))),
    upload: vi.fn(async (_name: string, _data: Buffer, _type: string) => {}),
    remove: vi.fn(async (_name: string, _eTag: string) => {}),
  } satisfies PublishTarget;
  return target;
}

describe("local folder publishing", () => {
  it("uploads supported root images with MIME types, ignoring subdirectories, symlinks and other files", async () => {
    await writeFile(join(dir, "keep.png"), "abc");
    await writeFile(join(dir, "notes.txt"), "notes");
    await mkdir(join(dir, "folder.png"));
    await symlink(join(dir, "keep.png"), join(dir, "link.png"));
    const target = setup();
    expect(await publishFolder(target, dir)).toEqual({ uploaded: 1, deleted: 0 });
    expect(target.upload).toHaveBeenCalledExactlyOnceWith("keep.png", Buffer.from("abc"), "image/png");
    expect(target.listImages).not.toHaveBeenCalled();
    expect(target.remove).not.toHaveBeenCalled();
  });

  it("only deletes missing images when explicitly requested, naming the listed version", async () => {
    await writeFile(join(dir, "keep.png"), "abc");
    const target = setup();
    expect(await publishFolder(target, dir, true)).toEqual({ uploaded: 1, deleted: 1 });
    expect(target.remove).toHaveBeenCalledExactlyOnceWith("old.png", '"old.png"');
  });

  it("keeps an image that was replaced after the listing", async () => {
    await writeFile(join(dir, "keep.png"), "abc");
    const target = setup();
    target.remove.mockRejectedValueOnce(new PreconditionError());
    expect(await publishFolder(target, dir, true)).toEqual({ uploaded: 1, deleted: 0 });
  });

  it("never deletes when an upload fails", async () => {
    await writeFile(join(dir, "keep.png"), "abc");
    const target = setup();
    target.upload.mockRejectedValue(new AccessError("Can't access the gateway - check the publisher token"));
    await expect(publishFolder(target, dir, true)).rejects.toBeInstanceOf(AccessError);
    expect(target.remove).not.toHaveBeenCalled();
  });

  it("refuses an empty mirror and rejects empty images before uploading", async () => {
    const target = setup();
    await expect(publishFolder(target, dir, true)).rejects.toThrow(/empty screenshot folder/);
    await writeFile(join(dir, "empty.png"), "");
    await expect(publishFolder(target, dir)).rejects.toThrow(/nonempty/);
    expect(target.upload).not.toHaveBeenCalled();
    expect(target.remove).not.toHaveBeenCalled();
  });

  it("requires the gateway URL and a publisher token file, with command-line overrides", () => {
    const env = { SCREENSHOT_DIR: dir, GATEWAY_URL: "https://gateway.example/", PUBLISHER_TOKEN_FILE: "/secure/publisher.token" };
    expect(loadPublishConfig(env, [])).toEqual({ sourceDir: dir, gatewayUrl: "https://gateway.example", tokenFile: "/secure/publisher.token", deleteMissing: false });
    expect(loadPublishConfig({}, [`--source-dir=${dir}`, "--gateway-url=https://g.example", "--token-file=/t", "--delete"]))
      .toMatchObject({ gatewayUrl: "https://g.example", tokenFile: "/t", deleteMissing: true });
    expect(() => loadPublishConfig({ ...env, PUBLISHER_TOKEN_FILE: undefined }, [])).toThrow(/PUBLISHER_TOKEN_FILE/);
    for (const url of ["http://gateway.example", "https://gateway.example/?token=secret", "not a url"]) {
      expect(() => loadPublishConfig({ ...env, GATEWAY_URL: url }, [])).toThrow(/HTTPS URL/);
      expect(() => loadPublishConfig({ ...env, GATEWAY_URL: url }, [])).not.toThrow(/secret/);
    }
    expect(() => loadPublishConfig(env, ["--delte"])).toThrow(/Use/);
  });
});
