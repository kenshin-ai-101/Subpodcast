/**
 * [INPUT]: store.current / audioOnly；offline.saved；audioHost.prepareAudio / resumeAudioIfWanted
 * [OUTPUT]: 无 UI；音频失活时让位
 * [POS]: load→prepareAudio 预缓冲；playSoon 触发 play；下载/ASR 落盘后可切本地；认领时接手 playing 并硬停 YT
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  pauseAudioHost,
  prepareAudio,
  releaseAudioHost,
  resumeAudioIfWanted,
} from "../lib/audioHost";
import { useJobs } from "../lib/jobs";
import { usesAudioEngine } from "../lib/media";
import { useOffline } from "../lib/offline";
import { alignCurrent } from "../lib/timemap";
import { useStore } from "../store";

/** 常驻哨兵：current 走音频时确保 host 已 prepare 并触发字幕自动对齐；失活则停掉。 */
export function AudioEngine() {
  const { current, audioOnly } = useStore(
    useShallow((s) => ({ current: s.current, audioOnly: s.audioOnly })),
  );
  const savedPath = useOffline((s) =>
    current ? (s.saved[current.id] ?? s.cached[current.id])?.path : undefined,
  );
  const hasSubtitles = useJobs((s) => !!(current && s.transcripts[current.id]?.segments.length));
  const active = usesAudioEngine(current, audioOnly);
  const wasActive = useRef(false);

  useEffect(() => {
    if (!active || !current) {
      wasActive.current = false;
      pauseAudioHost();
      releaseAudioHost();
      return;
    }
    // savedPath 变化：暂停态立刻切本地；播中 prepareAudio 锁源，pause 时 adopt
    prepareAudio(current);
    // YT shell → 音频（ASR/下载刚写出 enclosure）：UI 仍 playing 时由音频台接手，并硬停 iframe
    if (!wasActive.current) resumeAudioIfWanted();
    wasActive.current = true;
  }, [active, current?.id, current?.audioUrl, savedPath]);

  // 有字幕且走音频引擎时自动检测并对齐（同字节直接跳过；有参考声纹但音频不同则自动声纹对齐）
  useEffect(() => {
    if (active && current && hasSubtitles) {
      void alignCurrent(false);
    }
  }, [active, current?.id, hasSubtitles]);

  return null;
}
