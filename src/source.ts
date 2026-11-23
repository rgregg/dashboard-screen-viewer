export interface RemoteImage { name: string; eTag: string; size: number }
export interface ImageSource {
  listImages(): Promise<RemoteImage[]>;
  download(image: RemoteImage): Promise<Buffer>;
}

/** Storage the gateway can also write to on behalf of publishers. */
export interface ImageStore extends ImageSource {
  /** Stores the image, replacing any existing one, and returns its new ETag. */
  upload(name: string, data: Buffer, contentType: string): Promise<string>;
  /** Deletes the image; false if it doesn't exist. With an ETag, only deletes that version. */
  remove(name: string, eTag?: string): Promise<boolean>;
}

/** The image changed since the caller's ETag was read. */
export class PreconditionError extends Error {
  constructor() { super("Image changed"); this.name = "PreconditionError"; }
}

export class AccessError extends Error {
  constructor(message = "Can't access Blob container - check SAS expiry and permissions") { super(message); this.name = "AccessError"; }
}

export class NetworkError extends Error {
  constructor() { super("Blob transfer failed; retrying"); this.name = "NetworkError"; }
}

export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
};

export function imageContentType(name: string): string | undefined {
  if (!name || /[/\\\x00-\x1f\x7f]/.test(name)) return undefined;
  const extension = /\.([^.]+)$/.exec(name)?.[1].toLowerCase() ?? "";
  return Object.hasOwn(MIME, extension) ? MIME[extension] : undefined;
}

export function transferError(error: unknown): Error {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  // Never surface SDK error messages: they can contain the signed request URL.
  return status === 401 || status === 403 || status === 404 ? new AccessError() : new NetworkError();
}
