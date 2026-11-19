/**
 * [INPUT]: store.current / audioOnly；audioHost.prepareAudio
 * [OUTPUT]: 无 UI；音频失活时让位
 * [POS]: load→prepareAudio 预缓冲；playSoon 触发 play；本组件哨兵
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { pauseAudioHost, prepareAudio, releaseAudioHost } from "../lib/audioHost";
import { usesAudioEngine } from "../lib/media";
import { useStore } from "../store";

/** 常驻哨兵：current 走音频时确保 host 已 prepare；失活则停掉。 */
export function AudioEngine() {
  const { current, audioOnly } = useStore(
    useShallow((s) => ({ current: s.current, audioOnly: s.audioOnly })),
  );
  const active = usesAudioEngine(current, audioOnly);

  useEffect(() => {
    if (!active || !current) {
      pauseAudioHost();
      releaseAudioHost();
      return;
    }
    prepareAudio(current);
  }, [active, current?.id, current?.audioUrl]);

  return null;
}
