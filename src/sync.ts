import { EventEmitter } from "node:events";
import { AccessError, type ImageSource, type RemoteImage } from "./source.js";
import type { CachedImage, ImageCache } from "./cache.js";
import { offlineText, type Banner, type ViewState } from "./status.js";

export interface SyncDeps {
  source: ImageSource;
  cache: Pick<ImageCache, "load" | "stage">;
}

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

export class SyncEngine extends EventEmitter {
  private current: CachedImage[] = [];
  private banner: Banner = null;
  private inFlight = false;
  private rerun = false;
  private failures = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private deps: SyncDeps, private cfg: { pollSeconds: number }) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.current = this.deps.cache.load();
    this.emitState();
    void this.trigger();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  getState(): ViewState {
    return {
      images: this.current.map((i) => ({ name: i.name, url: `/images/${encodeURIComponent(i.name)}?v=${encodeURIComponent(i.eTag)}` })),
      banner: this.banner,
      message: this.current.length === 0 ? "No images found" : undefined,
    };
  }

  async trigger(): Promise<void> {
    if (this.inFlight) {
      // A change that lands mid-sync may not be in that sync's listing; run once more afterwards.
      this.rerun = true;
      return;
    }
    this.inFlight = true;
    clearTimeout(this.timer);
    try {
      await this.syncOnce();
      this.failures = 0;
      this.banner = null;
      this.schedule(this.pollMs());
    } catch (e) {
      this.failures++;
      this.applyFailure(e);
      this.schedule(Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** (this.failures - 1)));
    } finally {
      this.inFlight = false;
      this.emitState();
    }
    if (this.rerun) {
      this.rerun = false;
      await this.trigger();
    }
  }

  private emitState(): void {
    this.emit("state", this.getState());
  }

  private pollMs(): number {
    return this.cfg.pollSeconds * 1000;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.trigger(), ms);
  }

  private async syncOnce(): Promise<void> {
    const remote = await this.deps.source.listImages();
    const have = new Map(this.current.map((i) => [i.name, i.eTag]));
    const unchanged = remote.length === this.current.length && remote.every((r) => have.get(r.name) === r.eTag);
    if (unchanged) return;

    const staged = this.deps.cache.stage();
    try {
      for (const r of remote) await this.stageOne(staged, r, have);
      this.current = staged.commit();
    } catch (e) {
      staged.abort();
      throw e;
    }
  }

  private async stageOne(staged: ReturnType<ImageCache["stage"]>, r: RemoteImage, have: Map<string, string>) {
    if (have.get(r.name) === r.eTag) staged.keep(r.name);
    else await staged.add(r.name, r.eTag, await this.deps.source.download(r));
  }

  private applyFailure(e: unknown): void {
    const since = this.banner?.since ?? new Date();
    if (e instanceof AccessError) {
      this.banner = { kind: "access", since, text: e.message };
    } else {
      const sameKind = this.banner?.kind === "offline";
      const t = sameKind ? this.banner!.since : new Date();
      this.banner = { kind: "offline", since: t, text: offlineText(t) };
    }
  }
}
