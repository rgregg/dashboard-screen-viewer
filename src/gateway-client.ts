import { readFile } from "node:fs/promises";
import { AccessError, NetworkError, MAX_IMAGE_BYTES, PreconditionError, imageContentType, type ImageSource, type RemoteImage } from "./source.js";
import { validDeviceToken } from "./device-auth.js";

const MAX_LIST_BYTES = 1024 * 1024;

async function readBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new NetworkError();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) throw new NetworkError();
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

interface RequestOptions {
  method?: string;
  eTag?: string;
  body?: Buffer;
  contentType?: string;
  /** Statuses other than 2xx that consume() handles itself. */
  accept?: number[];
}

export class GatewaySource implements ImageSource {
  private accessMessage: string;

  constructor(private url: string, private tokenFile: string, private fetchFn: typeof fetch = fetch, role: "display" | "publisher" = "display") {
    this.accessMessage = role === "display"
      ? "Can't access download gateway - check the device credential"
      : "Can't access the gateway - check the publisher token";
  }

  private async request<T>(path: string, consume: (response: Response) => Promise<T>, options: RequestOptions = {}): Promise<T> {
    let token: string;
    try { token = (await readFile(this.tokenFile, "utf8")).trim(); } catch { throw new AccessError(this.accessMessage); }
    if (!validDeviceToken(token)) throw new AccessError(this.accessMessage);
    let response: Response | undefined;
    try {
      response = await this.fetchFn(`${this.url.replace(/\/$/, "")}/v1/images${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(options.eTag ? { "If-Match": options.eTag } : {}),
          ...(options.contentType ? { "Content-Type": options.contentType } : {}),
        },
        body: options.body ? new Uint8Array(options.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(options.body ? 120_000 : 60_000),
      });
      if (response.status === 401 || response.status === 403) throw new AccessError(this.accessMessage);
      if (!response.ok && !options.accept?.includes(response.status)) throw new NetworkError();
      return await consume(response);
    } catch (error) {
      if (error instanceof AccessError || error instanceof PreconditionError) throw error;
      throw new NetworkError();
    } finally {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }

  async listImages(): Promise<RemoteImage[]> {
    return this.request("", async (response) => {
      const value: unknown = JSON.parse((await readBody(response, MAX_LIST_BYTES)).toString("utf8"));
      if (!Array.isArray(value)) throw new NetworkError();
      const names = new Set<string>();
      return value.map((image: unknown) => {
        if (!image || typeof image !== "object") throw new NetworkError();
        const { name, eTag, size } = image as Partial<RemoteImage>;
        if (typeof name !== "string" || !imageContentType(name) || names.has(name) ||
            typeof eTag !== "string" || !eTag || eTag.length > 1024 || /[\r\n]/.test(eTag) ||
            typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES) {
          throw new NetworkError();
        }
        names.add(name);
        return { name, eTag, size };
      });
    });
  }

  async download(image: RemoteImage): Promise<Buffer> {
    return this.request(`/${encodeURIComponent(image.name)}`, async (response) => {
      if (response.headers.get("etag") !== image.eTag) throw new NetworkError();
      const bytes = await readBody(response, Math.min(image.size, MAX_IMAGE_BYTES));
      if (bytes.length !== image.size) throw new NetworkError();
      return bytes;
    }, { eTag: image.eTag });
  }

  /** Publisher only: stores the image through the gateway, replacing any existing version. */
  async upload(name: string, data: Buffer, contentType: string): Promise<void> {
    await this.request(`/${encodeURIComponent(name)}`, async () => undefined, { method: "PUT", body: data, contentType });
  }

  /** Publisher only: deletes that version of the image; already gone is fine. Throws PreconditionError if it changed. */
  async remove(name: string, eTag: string): Promise<void> {
    await this.request(`/${encodeURIComponent(name)}`, async (response) => {
      if (response.status === 412) throw new PreconditionError();
    }, { method: "DELETE", eTag, accept: [404, 412] });
  }
}
