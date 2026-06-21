import { describe, it, expect } from "vitest";
import {
  polygonToRect,
  stripTashkeel,
  stripPunctuation,
  normalizeWord,
  findExactConsecutive,
  findTolerantWindow,
  findSubstringMatch,
  findKeyPhraseCluster,
  firstStrongDir,
  type FlatWord,
} from "./match";

const cp = (n: number) => String.fromCharCode(n);
const flat = (tokens: string[]): FlatWord[] =>
  tokens.map((norm, globalIdx) => ({ norm, globalIdx }));
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

describe("polygonToRect", () => {
  it("computes a scaled bounding rect from an 8-point polygon", () => {
    expect(polygonToRect([1, 2, 3, 2, 3, 4, 1, 4], 10, 10)).toEqual({
      left: 10,
      top: 20,
      width: 20,
      height: 20,
    });
  });
});

describe("stripTashkeel", () => {
  const ALEF = cp(0x0627);
  const FATHA = cp(0x064e);
  const DAMMA = cp(0x064f);
  it("removes diacritics but preserves the Arabic letter", () => {
    expect(stripTashkeel(ALEF + FATHA + DAMMA)).toBe(ALEF);
  });
  it("does not strip the hamza letter (regression: range must not eat letters)", () => {
    const HAMZA = cp(0x0621);
    expect(stripTashkeel(HAMZA)).toBe(HAMZA);
  });
});

describe("stripPunctuation", () => {
  it("removes ascii + arabic punctuation and both unicode dashes", () => {
    const EN_DASH = cp(0x2013);
    const EM_DASH = cp(0x2014);
    expect(stripPunctuation("a" + EN_DASH + "b" + EM_DASH + "c,.")).toBe("abc");
  });
});

describe("normalizeWord", () => {
  it("strips, lowercases and trims", () => {
    expect(normalizeWord("  Hello, ")).toBe("hello");
  });
});

describe("findExactConsecutive", () => {
  it("finds the first consecutive run of tokens", () => {
    expect(sorted(findExactConsecutive(flat(["a", "x", "b", "c", "d"]), ["b", "c"]))).toEqual([2, 3]);
  });
  it("returns empty when there is no run", () => {
    expect(findExactConsecutive(flat(["a", "b"]), ["c", "d"]).size).toBe(0);
  });
});

describe("findTolerantWindow", () => {
  it("tolerates up to 10% mismatched tokens", () => {
    const cit = ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"];
    const words = flat(["t0", "t1", "XX", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]);
    expect(findTolerantWindow(words, cit).size).toBe(10);
  });
});

describe("findSubstringMatch", () => {
  it("matches a normalized substring spanning words", () => {
    const m = findSubstringMatch(flat(["alpha", "beta", "gamma"]), "beta gamm");
    expect(m.has(1)).toBe(true);
    expect(m.has(2)).toBe(true);
  });
  it("ignores citations shorter than 8 chars", () => {
    expect(findSubstringMatch(flat(["a", "b"]), "ab").size).toBe(0);
  });
});

describe("findKeyPhraseCluster", () => {
  it("finds a dense cluster of distinctive tokens", () => {
    const cit = ["alpha", "betaa", "gamma"];
    const words = flat(["intro", "alpha", "betaa", "gamma", "outro"]);
    expect(findKeyPhraseCluster(words, cit).size).toBeGreaterThan(0);
  });
  it("needs at least 3 distinctive tokens", () => {
    expect(findKeyPhraseCluster(flat(["alpha", "beta"]), ["alpha", "beta"]).size).toBe(0);
  });
});

describe("firstStrongDir", () => {
  it("rtl when the first strong char is Arabic", () => {
    expect(firstStrongDir(cp(0x0645) + " hello")).toBe("rtl");
  });
  it("ltr when the first strong char is Latin", () => {
    expect(firstStrongDir("hello " + cp(0x0645))).toBe("ltr");
  });
  it("defaults to rtl for digit-only input", () => {
    expect(firstStrongDir("123")).toBe("rtl");
  });
});
