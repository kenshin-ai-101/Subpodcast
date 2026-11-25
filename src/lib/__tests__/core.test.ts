import { describe, expect, it } from "vitest";
import { activeIndex } from "../playback";
import { pieceAt, pieces } from "../pieces";
import { isSafeHttpUrl } from "../safeUrl";
import { ACTIONS, checkCombo, keymap, prettyCombo } from "../shortcuts";
import { resolveChatModel } from "../modelResolve";
import { DEFAULTS } from "../settings";
import { buildCues, renderTranscript } from "../exportTranscript";
import { shortLines } from "../clipLines";
import { buildPlatformPost } from "../highlights";
import { resolveLocale, translate } from "../i18n";
import { createMediaClock } from "../mediaClock";
import { initialAudioOnly } from "../media";
import { anchorAt, toContent, toPlay, type TimeMap } from "../timemap";
import { filterFuzzy, fuzzyScore } from "../fuzzy";
import { clampLift, clampScale, resolveOrigScale, resolveSubScale } from "../reading";

describe("playback.activeIndex", () => {
  it("finds active segment via binary search with read-ahead lead", () => {
    const starts = [0, 5.2, 12.0, 20.5, 45.0];
    expect(activeIndex(starts, 0)).toBe(0);
    // 5.04 + 0.15 < 5.2 → 仍在首句；5.05 + 0.15 ≥ 5.2 → 提前切到下一句
    expect(activeIndex(starts, 5.04)).toBe(0);
    expect(activeIndex(starts, 5.05)).toBe(1);
    expect(activeIndex(starts, 5.2)).toBe(1);
    expect(activeIndex(starts, 19.9)).toBe(2);
    expect(activeIndex(starts, 100)).toBe(4);
    // 片头尚未开讲返回 -1，避免提前显示首句
    expect(activeIndex([15.0, 22.0], 3.0)).toBe(-1);
    expect(activeIndex([], 0)).toBe(-1);
  });
});

describe("media.initialAudioOnly", () => {
  it("prefers video when online episode has videoId to stay synced with YouTube captions", () => {
    const dual = {
      id: "e1",
      showId: "s1",
      guid: "g1",
      title: "Dual Episode",
      videoId: "ZAzWPE9CItg",
      audioUrl: "https://example.com/ep.mp3",
      progress: 0,
      hasTranscript: true,
    };
    expect(initialAudioOnly(dual)).toBe(false);
    expect(initialAudioOnly({ ...dual, videoId: null })).toBe(true);
  });
});

describe("pieces", () => {
  it("splits English blocks into readable cues", () => {
    const ps = pieces("Hello world. Next sentence here.", false);
    expect(ps.length).toBeGreaterThanOrEqual(2);
    expect(pieceAt("Hello world. Next sentence here.", false, 0.1)).toContain("Hello");
  });
});

describe("timemap", () => {
  const map: TimeMap = {
    playBytes: 1,
    method: "manual",
    pieces: [
      { refStart: 0, refEnd: 10, playStart: 5 },
      { refStart: 10, refEnd: 20, playStart: 20 },
    ],
  };

  it("converts subtitle time to play clock and back", () => {
    expect(toPlay(map, 3)).toBe(8);
    expect(toContent(map, 8).at).toBe(3);
    // 播放文件 10–20 是广告空隙
    expect(toContent(map, 15).gapEnd).toBe(20);
  });

  it("anchors a line so later speech follows the play clock", () => {
    const next = anchorAt(null, 5, 12, 1);
    expect(toPlay(next, 5)).toBeCloseTo(12, 5);
  });
});

describe("mediaClock", () => {
  it("extrapolates while playing when the player clock stalls", () => {
    let now = 1000;
    const c = createMediaClock(() => now);
    c.setPlaying(true);
    c.setRate(1);
    const a = c.sample(10);
    expect(a).toBe(10);
    // 同一读数：应略往前走（墙钟外推）
    now += 150;
    const b = c.sample(10);
    expect(b).toBeGreaterThan(a);
  });

  it("re-anchors on seek jumps", () => {
    const c = createMediaClock();
    c.setPlaying(true);
    c.sample(10);
    expect(c.sample(40)).toBe(40);
  });

  it("holds async seek target until YouTube catches up, both playing and paused", () => {
    let now = 1000;
    const c = createMediaClock(() => now);
    c.setPlaying(true);
    c.sample(10);
    c.seek(500, 10);
    // 播放器仍报旧读数：锁在 500 不回跳
    now += 100;
    expect(c.sample(10.1)).toBe(500);
    // 播放器落到附近关键帧：立刻收敛到真实读数
    now += 200;
    expect(c.sample(499.6)).toBe(499.6);

    // 暂停态 seek：即使等待很久也不应被旧读数覆盖
    c.setPlaying(false);
    c.seek(120, 499.6);
    now += 5000;
    expect(c.sample(499.6)).toBe(120);
    // 暂停态 iframe 更新完成后立即同步
    expect(c.sample(120.4)).toBe(120.4);
  });

  it("handles short seeks without settling prematurely on normal playback drift", () => {
    let now = 1000;
    const c = createMediaClock(() => now);
    c.setPlaying(true);
    c.sample(100);
    c.seek(101.8, 100);
    // 100ms 后原时钟只自然前进了 0.1s，尚未落地，应继续锁在目标
    now += 100;
    expect(c.sample(100.1)).toBe(101.8);
    // 到达目标附近后落地
    now += 100;
    expect(c.sample(101.6)).toBe(101.6);
  });
});

describe("safeUrl.isSafeHttpUrl", () => {
  it("allows only http and https URLs", () => {
    expect(isSafeHttpUrl("https://subpodcast.app/ep/1")).toBe(true);
    expect(isSafeHttpUrl("http://localhost:1420")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeHttpUrl("open://custom")).toBe(false);
    expect(isSafeHttpUrl("not a url")).toBe(false);
  });
});

describe("shortcuts registry", () => {
  it("exposes all 21 actions and detects conflicts and reserved combos", () => {
    expect(ACTIONS.length).toBe(21);
    const m = keymap({ playPause: ["P"] });
    expect(m.playPause).toEqual(["P"]);
    expect(checkCombo("Mod+Q", "playPause").reserved).toBe(true);
    expect(checkCombo("F", "playPause").takenBy).toBe("fullscreen");
    expect(prettyCombo("Mod+/").length).toBeGreaterThan(0);
    expect(m.subBigger).toEqual(["Mod+="]);
    expect(m.subSmaller).toEqual(["Mod+-"]);
  });
});

describe("reading subtitle scales and lift", () => {
  it("resolves continuous scale over legacy presets and keeps orig synced unless overridden", () => {
    expect(resolveSubScale({ subtitleSize: "l" })).toBe(1.18);
    expect(resolveSubScale({ subtitleSize: "l", subtitleScale: 1.4 })).toBe(1.4);
    expect(resolveOrigScale({ subtitleSize: "m", subtitleScale: 1.3 })).toBe(1.3);
    expect(resolveOrigScale({ subtitleSize: "m", subtitleScale: 1.3, subtitleOrigScale: 0.9 })).toBe(0.9);
    expect(clampScale(0.2)).toBe(0.7);
    expect(clampScale(3.5)).toBe(2);
    expect(clampScale(1.13)).toBe(1.15);
    expect(clampLift(-20)).toBe(-4);
    expect(clampLift(120)).toBe(70);
    expect(clampLift(12.34)).toBe(12.3);
  });
});

describe("settings & modelResolve", () => {
  it("defaults shareTranscripts to false for privacy", () => {
    expect(DEFAULTS.shareTranscripts).toBe(false);
  });

  it("prefers settings.chatModel for active chatProvider", () => {
    const s = { ...DEFAULTS, chatProvider: "deepseek", chatModel: "deepseek-reasoner" };
    expect(resolveChatModel(s)).toBe("deepseek-reasoner");
    const s2 = { ...DEFAULTS, chatProvider: "deepseek", chatModel: "" };
    expect(resolveChatModel(s2)).toBe(DEFAULTS.providers.deepseek.model);
  });
});

describe("exportTranscript & clipLines", () => {
  it("formats SRT bilingual export cleanly", () => {
    const cues = buildCues([{ start: 1.5, end: 4.2, text: "Hello world" }], ["你好世界"], "bilingual", true);
    const content = renderTranscript({
      format: "srt",
      episode: {
        id: "ep1",
        showId: "s1",
        guid: "g1",
        title: "Test Episode",
        progress: 0,
        hasTranscript: true,
        showTitle: "Test Show",
      },
      cues,
      sourceLabel: "官方字幕",
    });
    expect(content).toContain("00:00:01,500 --> 00:00:04,200");
    expect(content).toContain("你好世界");
    expect(content).toContain("Hello world");
  });

  it("splits long Chinese caption lines within max CJK budget", () => {
    const lines = shortLines("这是一段用来测试竖屏字幕自动换行的较长中文口语表达内容", 12);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("这是一段用来测试竖屏字幕自动换行的较长中文口语表达内容");
  });
});

describe("i18n engine", () => {
  it("resolves explicit locales and translates zh-CN / zh-TW / en", () => {
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh-TW")).toBe("zh-TW");
    expect(resolveLocale("en")).toBe("en");
    expect(translate("zh-CN", "首页")).toBe("首页");
    expect(translate("zh-TW", "首页")).toBe("首頁");
    expect(translate("en", "首页")).toBe("Home");
  });
});

describe("highlights.buildPlatformPost", () => {
  it("updates short, article, and social copy when regenerated while preserving cover", () => {
    const base = {
      ep: { title: "Ep 1", showTitle: "Show A", videoId: "abc123" },
      coverHook: "封面【大字】",
      coverSub: "封面副标题",
      segments: [{ start: 10, end: 15, text: "Original line" }],
      zh: ["中文原话"],
      startIdx: 0,
      endIdx: 0,
      clipStart: 10,
      tags: ["AI"],
    };
    const v1Short = buildPlatformPost("short", {
      ...base,
      title: "第一版标题",
      shareCopy: "第一版正文 #AI",
      articleCopy: "第一版导读",
    });
    const v2Short = buildPlatformPost("short", {
      ...base,
      title: "第二版标题",
      shareCopy: "第二版正文 #AI",
      articleCopy: "第二版导读",
    });
    expect(v1Short).toContain("第一版标题");
    expect(v2Short).toContain("第二版标题");
    expect(v2Short).not.toBe(v1Short);

    const v1Article = buildPlatformPost("article", {
      ...base,
      title: "第一版标题",
      shareCopy: "第一版正文",
      articleCopy: "第一版导读",
    });
    const v2Article = buildPlatformPost("article", {
      ...base,
      title: "第二版标题",
      shareCopy: "第二版正文",
      articleCopy: "第二版导读",
    });
    expect(v1Article).toContain("# 封面大字");
    expect(v2Article).toContain("# 封面大字");
    expect(v2Article).toContain("第二版导读");
    expect(v2Article).not.toBe(v1Article);

    const v1Social = buildPlatformPost("social", {
      ...base,
      title: "第一版标题",
      shareCopy: "第一版开头\n第二行",
      articleCopy: "第一版导读",
    });
    const v2Social = buildPlatformPost("social", {
      ...base,
      title: "第二版标题",
      shareCopy: "第二版开头\n第二行",
      articleCopy: "第二版导读",
    });
    expect(v1Social).toContain("「第一版标题」");
    expect(v2Social).toContain("「第二版标题」");
    expect(v2Social).toContain("第二版开头");
    expect(v2Social).not.toBe(v1Social);
  });
});

describe("fuzzy.filterFuzzy", () => {
  const shows = [
    { id: "1", title: "Lex Fridman Podcast", zh: "Lex Fridman 播客", author: "Lex Fridman" },
    { id: "2", title: "张小珺Jùn｜商业访谈录", zh: "张小珺｜商业访谈录", author: "张小珺" },
    { id: "3", title: "Latent Space", zh: "潜空间", author: "swyx & Alessio" },
    { id: "4", title: "The a16z Show", zh: "a16z 播客", author: "Andreessen Horowitz" },
  ];
  const fields = (s: (typeof shows)[number]) => [s.zh, s.title, s.author];

  it("matches exact, prefix, substring, acronym subsequence, and Chinese alias queries", () => {
    expect(filterFuzzy(shows, "", fields).map((x) => x.id)).toEqual(["1", "2", "3", "4"]);
    expect(filterFuzzy(shows, "lex", fields).map((x) => x.id)).toEqual(["1"]);
    expect(filterFuzzy(shows, "lfp", fields).map((x) => x.id)).toEqual(["1"]);
    expect(filterFuzzy(shows, "张访", fields).map((x) => x.id)).toEqual(["2"]);
    expect(filterFuzzy(shows, "潜空", fields).map((x) => x.id)).toEqual(["3"]);
    expect(filterFuzzy(shows, "swyx", fields).map((x) => x.id)).toEqual(["3"]);
    expect(filterFuzzy(shows, "a16z 播客", fields).map((x) => x.id)).toEqual(["4"]);
    expect(filterFuzzy(shows, "not-found-xyz", fields)).toEqual([]);
  });

  it("ranks prefix/exact matches ahead of loose subsequence matches", () => {
    const exact = fuzzyScore("lex", ["Lex Fridman Podcast"]);
    const subseq = fuzzyScore("lfp", ["Lex Fridman Podcast"]);
    expect(exact).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });
});
