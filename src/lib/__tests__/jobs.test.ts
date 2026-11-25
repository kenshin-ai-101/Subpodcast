import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Episode, type Transcript } from "../api";
import {
  autoTranslate,
  countMissingTranslations,
  hasZhTranslation,
  parseZhTranslation,
  shouldAutoTranslate,
  translateEpisode,
  useJobs,
} from "../jobs";
import { DEFAULTS } from "../settings";
import { useStore } from "../../store";

const ep: Episode = {
  id: "ep-en-1",
  showId: "show-1",
  guid: "guid-1",
  title: "English Podcast Episode",
  progress: 0,
  hasTranscript: true,
};

const transcript: Transcript = {
  episodeId: ep.id,
  source: "youtube",
  language: "en",
  segments: [
    { start: 0, end: 4, text: "Hello everyone and welcome back." },
    { start: 4, end: 8, text: "Today we talk about podcasts." },
    { start: 8, end: 12, text: "   " },
  ],
};

function flush() {
  return new Promise((r) => setTimeout(r, 20));
}

describe("jobs translation helpers", () => {
  it("parses zh blob safely and aligns to segment length", () => {
    expect(parseZhTranslation(null, 3)).toEqual([null, null, null]);
    expect(parseZhTranslation("not-json", 2)).toEqual([null, null]);
    expect(parseZhTranslation('["你好"]', 3)).toEqual(["你好", null, null]);
    expect(parseZhTranslation('["你好", 123, "世界"]', 3)).toEqual(["你好", null, "世界"]);
  });

  it("detects existing zh translation only when non-empty translated lines exist", () => {
    expect(hasZhTranslation(undefined)).toBe(false);
    expect(hasZhTranslation([])).toBe(false);
    expect(hasZhTranslation([null, "", "   "])).toBe(false);
    expect(hasZhTranslation(["你好", null])).toBe(true);
  });

  it("counts missing translations ignoring blank source segments", () => {
    expect(countMissingTranslations(transcript.segments, [null, null, null])).toBe(2);
    expect(countMissingTranslations(transcript.segments, ["大家好", null, null])).toBe(1);
    expect(countMissingTranslations(transcript.segments, ["大家好", "今天聊播客", null])).toBe(0);
  });

  it("skips autoTranslate when zh translation already exists or in original mode", () => {
    expect(shouldAutoTranslate({ items: [null, null], running: false }, "bilingual")).toBe(true);
    expect(shouldAutoTranslate({ items: [null, null], running: false }, "original")).toBe(false);
    expect(shouldAutoTranslate({ items: ["大家好", "今天聊播客"], running: false }, "bilingual")).toBe(false);
    // 已有部分 zh 翻译（例如 YouTube 对齐中文轨或此前保存的译文）也不再自动翻译
    expect(shouldAutoTranslate({ items: ["大家好", null], running: false, engine: "youtube" }, "bilingual")).toBe(
      false,
    );
    expect(shouldAutoTranslate({ items: [null, null], running: true }, "bilingual")).toBe(false);
    expect(shouldAutoTranslate({ items: [null, null], running: false, error: "429" }, "bilingual")).toBe(false);
  });
});

describe("autoTranslate with existing zh cache", () => {
  beforeEach(() => {
    useJobs.setState({
      transcripts: { [ep.id]: transcript },
      official: { [ep.id]: "found" },
      officialError: {},
      translations: {},
      asrRunning: {},
      asrProgress: {},
      asrError: {},
    });
    useStore.setState({
      settings: {
        ...DEFAULTS,
        subtitleMode: "bilingual",
        translateMode: "google",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads existing full zh translation on reopen without calling Google Translate", async () => {
    const getBlob = vi.spyOn(api, "getBlob").mockImplementation(async (_id, kind) => {
      if (kind === "zh") return JSON.stringify(["大家好，欢迎回来。", "今天我们聊播客。", null]);
      if (kind === "zh-engine") return "google";
      return null;
    });
    const translateTexts = vi.spyOn(api, "translateTexts").mockResolvedValue([]);
    const setBlob = vi.spyOn(api, "setBlob").mockResolvedValue();

    autoTranslate(ep);
    await flush();

    expect(getBlob).toHaveBeenCalledWith(ep.id, "zh");
    expect(translateTexts).not.toHaveBeenCalled();
    expect(setBlob).not.toHaveBeenCalled();
    expect(useJobs.getState().translations[ep.id]?.items).toEqual([
      "大家好，欢迎回来。",
      "今天我们聊播客。",
      null,
    ]);
  });

  it("loads existing partial zh translation on reopen without triggering Google Translate", async () => {
    vi.spyOn(api, "getBlob").mockImplementation(async (_id, kind) => {
      if (kind === "zh") return JSON.stringify(["大家好，欢迎回来。", null, null]);
      if (kind === "zh-engine") return "youtube";
      return null;
    });
    const translateTexts = vi.spyOn(api, "translateTexts").mockResolvedValue([]);

    autoTranslate(ep);
    autoTranslate(ep);
    await flush();

    expect(translateTexts).not.toHaveBeenCalled();
    expect(useJobs.getState().translations[ep.id]?.items[0]).toBe("大家好，欢迎回来。");
  });

  it("auto-translates once when no zh translation exists yet and deduplicates concurrent calls", async () => {
    vi.spyOn(api, "getBlob").mockResolvedValue(null);
    const translateTexts = vi
      .spyOn(api, "translateTexts")
      .mockResolvedValue(["大家好，欢迎回来。", "今天我们聊播客。"]);
    const setBlob = vi.spyOn(api, "setBlob").mockResolvedValue();
    vi.spyOn(api, "shareTranslation").mockResolvedValue("ok");

    autoTranslate(ep);
    autoTranslate(ep);
    await flush();

    expect(translateTexts).toHaveBeenCalledTimes(1);
    expect(translateTexts).toHaveBeenCalledWith([
      "Hello everyone and welcome back.",
      "Today we talk about podcasts.",
    ]);
    expect(setBlob).toHaveBeenCalledWith(
      ep.id,
      "zh",
      JSON.stringify(["大家好，欢迎回来。", "今天我们聊播客。", null]),
    );
  });

  it("manual translateEpisode fills only missing lines and preserves existing zh", async () => {
    vi.spyOn(api, "getBlob").mockImplementation(async (_id, kind) => {
      if (kind === "zh") return JSON.stringify(["已有第一句", null, null]);
      if (kind === "zh-engine") return "llm";
      return null;
    });
    const translateTexts = vi.spyOn(api, "translateTexts").mockResolvedValue(["补全第二句"]);
    const setBlob = vi.spyOn(api, "setBlob").mockResolvedValue();

    await translateEpisode(ep, transcript);

    expect(translateTexts).toHaveBeenCalledTimes(1);
    expect(translateTexts).toHaveBeenCalledWith(["Today we talk about podcasts."]);
    expect(setBlob).toHaveBeenCalledWith(ep.id, "zh", JSON.stringify(["已有第一句", "补全第二句", null]));
  });
});
