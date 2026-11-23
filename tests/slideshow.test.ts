import { describe, it, expect } from "vitest";
import { nextIndex, applyPending, indexOfShown } from "../public/slideshow.js";

const s = (...names: string[]) => names.map((name) => ({ name, url: `/images/${name}` }));

describe("slideshow logic", () => {
  it("nextIndex wraps around and returns 0 for an empty list", () => {
    expect(nextIndex(0, 3)).toBe(1);
    expect(nextIndex(2, 3)).toBe(0);
    expect(nextIndex(5, 0)).toBe(0);
    expect(nextIndex(-1, 3)).toBe(0);
  });

  it("applyPending returns current until atBoundary is true, then the pending set", () => {
    const cur = s("a.png"), pend = s("b.png");
    expect(applyPending(cur, pend, false)).toBe(cur);
    expect(applyPending(cur, pend, true)).toBe(pend);
    expect(applyPending(cur, null, true)).toBe(cur);
  });

  it("indexOfShown finds the image still on screen after a swap, else -1", () => {
    expect(indexOfShown(s("a.png", "b.png", "c.png"), "b.png")).toBe(1);
    expect(indexOfShown(s("a.png"), "gone.png")).toBe(-1);
    expect(indexOfShown(s("a.png"), undefined)).toBe(-1);
  });
});
