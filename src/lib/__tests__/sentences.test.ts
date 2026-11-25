import { describe, expect, it } from "vitest";
import { estimateMarks, spokenChars, splitSentences } from "../sentences";

describe("splitSentences", () => {
  it("splits on Chinese and English stops", () => {
    const text = "这是第一句。这是第二句比较长。This is one. This is two longer.";
    const ranges = splitSentences(text);
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual([
      "这是第一句。",
      "这是第二句比较长。",
      "This is one.",
      "This is two longer.",
    ]);
  });

  it("merges very short trailing fragments into the previous sentence", () => {
    const text = "这是一句较长的话。家。";
    const ranges = splitSentences(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(...ranges[0])).toBe(text);
  });

  it("cuts long sentences at commas before MAX_CHARS", () => {
    const chunk = "甲，".repeat(90);
    const text = `${chunk}结束。`;
    const ranges = splitSentences(text);
    expect(ranges.length).toBeGreaterThan(1);
    for (const [a, b] of ranges) {
      expect(b - a).toBeLessThanOrEqual(160);
    }
  });
});

describe("spokenChars", () => {
  it("returns the end of the active mark at a given time", () => {
    const marks = estimateMarks("你好世界", 4);
    expect(marks.length).toBeGreaterThan(0);
    expect(spokenChars(marks, -1)).toBe(0);
    expect(spokenChars(marks, marks[0].from)).toBe(marks[0].e);
    const last = marks[marks.length - 1];
    expect(spokenChars(marks, last.to)).toBe(last.e);
  });
});
