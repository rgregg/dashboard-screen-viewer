export type Banner = null | { kind: "offline" | "access"; since: Date; text: string };

export interface ViewState {
  images: { name: string; url: string }[];
  banner: Banner;
  message?: string;
}

export function offlineText(since: Date): string {
  return `No connection since ${since.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}
