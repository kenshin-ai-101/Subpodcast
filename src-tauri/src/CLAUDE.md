# src-tauri/src/
> L2 | 父级: /CLAUDE.md

成员清单
lib.rs: Tauri 命令面与启动（含 list_models / export_opml / storage_info / open_data_folder / clear_temp）
main.rs: 二进制入口
model.rs: Show/Episode/Segment/Transcript 契约
db.rs: SQLite WAL 读写
feeds.rs: 订阅解析与搜索；MAX_EPISODES=300；小宇宙 __NEXT_DATA__；搜索可置顶乔木精读
qiaomu.rs: 乔木精读 *.qiaomu.ai / rss.qiaomu.ai 频道拉取（对齐 SubCast）
import.rs: YouTube 浏览器订阅导入、隐私设置入口、OPML 导出
ytdlp.rs: 定位或下载 yt-dlp（导入用）
captions.rs: 官方字幕拉取与分句
translate.rs: 谷歌 / LLM 翻译批次
llm.rs: OpenAI/Anthropic 对话
net.rs: 统一 HTTP 客户端与代理；effective_proxy 供子进程
secrets.rs: 钥匙串 API Key

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
