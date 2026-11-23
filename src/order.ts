const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Filename order for the slideshow: case-insensitive, with digit runs compared as numbers. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}
