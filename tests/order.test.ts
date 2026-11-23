import { describe, it, expect } from "vitest";
import { compareNames } from "../src/order.js";

describe("compareNames", () => {
  it("orders numerically and case-insensitively", () => {
    expect(["10.png", "2.png", "B.png", "a.png"].sort(compareNames)).toEqual(["2.png", "10.png", "a.png", "B.png"]);
  });
  it("is stable for names differing only by case", () => {
    expect(["a.png", "A.png"].sort(compareNames)).toEqual(["a.png", "A.png"]);
    expect(["A.png", "a.png"].sort(compareNames)).toEqual(["A.png", "a.png"]);
  });
  it("does not throw on non-ASCII names", () => {
    expect(() => ["é.png", "日本.png", "😀.png"].sort(compareNames)).not.toThrow();
  });
});
