/**
 * [INPUT]: store.current / audioOnly；offline.saved；audioHost.prepareAudio
 * [OUTPUT]: 无 UI；音频失活时让位
 * [POS]: load→prepareAudio 预缓冲；playSoon 触发 play；下载完成时再 prepare（播中由 host 锁源）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { pauseAudioHost, prepareAudio, releaseAudioHost } from "../lib/audioHost";
import { usesAudioEngine } from "../lib/media";
import { useOffline } from "../lib/offline";
import { useStore } from "../store";

/** 常驻哨兵：current 走音频时确保 host 已 prepare；失活则停掉。 */
export function AudioEngine() {
  const { current, audioOnly } = useStore(
    useShallow((s) => ({ current: s.current, audioOnly: s.audioOnly })),
  );
  const savedPath = useOffline((s) => (current ? s.saved[current.id]?.path : undefined));
  const active = usesAudioEngine(current, audioOnly);

  useEffect(() => {
    if (!active || !current) {
      pauseAudioHost();
      releaseAudioHost();
      return;
    }
    // savedPath 变化：暂停态立刻切本地；播中 prepareAudio 锁源，pause 时 adopt
    prepareAudio(current);
  }, [active, current?.id, current?.audioUrl, savedPath]);

  return null;
}
