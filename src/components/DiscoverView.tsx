/**
 * [INPUT]: picks、PromoBanner、store
 * [OUTPUT]: DiscoverView — 话题筛选 + 精选网格
 * [POS]: 侧栏「发现」主面板
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Loader2, Plus, Youtube } from "lucide-react";
import { api, errText } from "../lib/api";
import { PICKS, TOPICS, isSubscribed, pickName, pickSub, type Pick, type Topic } from "../lib/picks";
import { HOME_SHOW_FEED } from "../lib/showLinks";
import { useStore } from "../store";
import { HomeShowBanner, usePromo } from "./PromoBanner";

function PickCard({
  p,
  subscribed,
  onOpen,
  action,
}: {
  p: Pick;
  subscribed: boolean;
  onOpen: () => void;
  action: React.ReactNode;
}) {
  return (
    <div
      className={`pick-tile ${subscribed ? "done" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="tile-cover">
        <img src={p.cover} alt="" loading="lazy" />
        {p.video && (
          <span className="tile-badge">
            <Youtube size={11} /> 视频
          </span>
        )}
        <div className="tile-action">{action}</div>
      </div>
      <p className="tile-name clamp1">{pickName(p)}</p>
      <p className="tile-sub clamp1">{pickSub(p)}</p>
      <p className="pick-intro">{p.intro}</p>
    </div>
  );
}

function TopicChips({ topics, setTopics }: { topics: Topic[]; setTopics: (t: Topic[]) => void }) {
  const toggle = (x: Topic) => setTopics(topics.includes(x) ? topics.filter((y) => y !== x) : [...topics, x]);
  return (
    <div className="chips left">
      <button type="button" className={`chip ${topics.length === 0 ? "on" : ""}`} onClick={() => setTopics([])}>
        全部
      </button>
      {TOPICS.map((x) => (
        <button key={x} type="button" className={`chip ${topics.includes(x) ? "on" : ""}`} onClick={() => toggle(x)}>
          {x}
        </button>
      ))}
    </div>
  );
}

const visible = (topics: Topic[]) => PICKS.filter((p) => !topics.length || p.topics.some((x) => topics.includes(x)));

export function DiscoverView() {
  const { shows, reloadShows, notify, go, saveSettings } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      reloadShows: s.reloadShows,
      notify: s.notify,
      go: s.go,
      saveSettings: s.saveSettings,
    })),
  );
  const [adding, setAdding] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const promo = usePromo();
  const bannerHidden = useStore((s) => s.settings.homeBannerHidden);
  const showBanner = promo && !bannerHidden;
  const home = PICKS.find((p) => p.input === HOME_SHOW_FEED);

  const subscribed = (p: Pick) => isSubscribed(p, shows);

  /** 点 + 只订阅，留在发现页；点封面才进频道预览。 */
  const add = async (input: string, title: string) => {
    setAdding(input);
    try {
      await api.addSubscription(input);
      await reloadShows();
      notify(`已订阅「${title}」`);
    } catch (e) {
      notify(errText(e));
    } finally {
      setAdding(null);
    }
  };

  const subBtn = (input: string, title: string, done: boolean) =>
    done ? (
      <span className="tile-done" title="已订阅">
        <Check size={16} />
      </span>
    ) : (
      <button
        type="button"
        className="tile-add"
        title="订阅"
        onClick={(e) => {
          e.stopPropagation();
          void add(input, title);
        }}
        disabled={adding != null}
      >
        {adding === input ? <Loader2 size={16} className="spin" /> : <Plus size={18} />}
      </button>
    );

  return (
    <div className="page">
      <h1 className="page-title">发现</h1>
      <p className="muted page-sub">精选海外与中文好节目，订阅后字幕和中文翻译开箱即用。想找别的节目，用上方搜索框。</p>
      {showBanner && home && !topics.length && (
        <HomeShowBanner
          onHide={() => {
            void saveSettings({ homeBannerHidden: true });
            notify("好的，不再显示。可以在设置 › 通用里重新打开");
          }}
          subscribed={subscribed(home)}
          busy={adding === home.input}
          onSubscribe={() => void add(home.input, pickName(home))}
          onOpen={() => go({ kind: "channel", input: home.input })}
        />
      )}
      <TopicChips topics={topics} setTopics={setTopics} />
      <div className="tile-grid">
        {visible(topics)
          .filter((p) => !(showBanner && p === home && !topics.length))
          .map((p) => (
            <PickCard
              key={p.id}
              p={p}
              subscribed={subscribed(p)}
              onOpen={() => go({ kind: "channel", input: p.input })}
              action={subBtn(p.input, pickName(p), subscribed(p))}
            />
          ))}
      </div>
    </div>
  );
}