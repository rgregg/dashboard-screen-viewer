import { ContainerClient } from "@azure/storage-blob";
import type { Readable } from "node:stream";
import { AccessError, MAX_IMAGE_BYTES, NetworkError, PreconditionError, imageContentType, transferError, type ImageSource, type ImageStore, type RemoteImage } from "./source.js";

export { AccessError, MAX_IMAGE_BYTES, NetworkError, PreconditionError, imageContentType, transferError, type ImageSource, type ImageStore, type RemoteImage };

export function createContainerClient(url: string): ContainerClient {
  return new ContainerClient(url, undefined, {
    retryOptions: { maxTries: 3, tryTimeoutInMs: 30_000 },
  });
}

type ContainerOps = Pick<ContainerClient, "listBlobsFlat" | "getBlobClient" | "getBlockBlobClient" | "deleteBlob">;

export class BlobSource implements ImageStore {
  constructor(private container: ContainerOps) {}

  async listImages(): Promise<RemoteImage[]> {
    try {
      const images: RemoteImage[] = [];
      for await (const blob of this.container.listBlobsFlat()) {
        const { contentLength: size, etag: eTag } = blob.properties;
        if (imageContentType(blob.name) && size && size > 0 && size <= MAX_IMAGE_BYTES && eTag) {
          images.push({ name: blob.name, eTag, size });
        }
      }
      return images;
    } catch (error) {
      throw transferError(error);
    }
  }

  async download(image: RemoteImage): Promise<Buffer> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60_000);
    try {
      const response = await this.container.getBlobClient(image.name).download(0, undefined, {
        conditions: { ifMatch: image.eTag },
        abortSignal: abort.signal,
      });
      const stream = response.readableStreamBody as Readable | undefined;
      const chunks: Buffer[] = [];
      let received = 0;
      try {
        if (!stream || response.contentLength !== image.size || image.size <= 0 || image.size > MAX_IMAGE_BYTES) {
          throw new NetworkError();
        }
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          received += bytes.length;
          if (received > image.size) throw new NetworkError();
          chunks.push(bytes);
        }
      } finally {
        stream?.destroy();
      }
      if (received !== image.size) throw new NetworkError();
      return Buffer.concat(chunks);
    } catch (error) {
      throw transferError(error);
    } finally {
      abort.abort();
      clearTimeout(timer);
    }
  }

  async upload(name: string, data: Buffer, contentType: string): Promise<string> {
    try {
      const response = await this.container.getBlockBlobClient(name).uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType },
        concurrency: 1,
      });
      if (!response.etag) throw new NetworkError();
      return response.etag;
    } catch (error) {
      if (error instanceof NetworkError) throw error;
      throw transferError(error);
    }
  }

  async remove(name: string, eTag?: string): Promise<boolean> {
    try {
      await this.container.deleteBlob(name, eTag ? { conditions: { ifMatch: eTag } } : {});
      return true;
    } catch (error) {
      const status = (error as { statusCode?: number } | null)?.statusCode;
      if (status === 404) return false;
      if (status === 412) throw new PreconditionError();
      throw transferError(error);
    }
  }
}
