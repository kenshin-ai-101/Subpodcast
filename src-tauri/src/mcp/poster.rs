use super::*;

#[cfg(not(target_os = "macos"))]
fn escaped(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(super) async fn render(ctx: &McpCtx, args: &Value) -> Result<Value> {
    let dest = validate_output_path(args["outputPath"].as_str().unwrap_or(""))?;
    let ep = match args["reference"].as_str().filter(|s| !s.is_empty()) {
        Some(reference) => Some(resolve_episode_ref(ctx, reference).await?),
        None => None,
    };
    let mut orig = args["orig"].as_str().unwrap_or("").to_owned();
    let zh = args["zh"].as_str().unwrap_or("");
    if orig.is_empty() && zh.is_empty() {
        let ep = ep
            .as_ref()
            .ok_or_else(|| anyhow!("请提供原文、译文或单集"))?;
        let conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
        orig = db::load_transcript(&conn, &ep.id)?
            .and_then(|t| t.segments.into_iter().next())
            .ok_or_else(|| anyhow!("单集还没有字幕"))?
            .text;
    }
    let (bg, fg) = match args["theme"].as_str().unwrap_or("paper") {
        "paper" => ("#f7f5ef", "#242521"),
        "warm" => ("#ffe6d7", "#602f24"),
        "night" => ("#192331", "#eef3fa"),
        "bamboo" => ("#e2eddf", "#254f39"),
        "sand" => ("#eee1c7", "#4a3926"),
        other => bail!("未知海报主题：{other}"),
    };
    let label = ep
        .as_ref()
        .map(|e| e.title.as_str())
        .unwrap_or("声译 · Subpodcast");
    #[cfg(target_os = "macos")]
    {
        let tmp = tempfile::tempdir()?;
        let script = tmp.path().join("poster.js");
        std::fs::write(&script, include_str!("poster-macos.js"))?;
        let out = tokio::process::Command::new("/usr/bin/osascript")
            .args(["-l", "JavaScript"])
            .arg(script)
            .args([orig.as_str(), zh, label, bg, fg])
            .arg(&dest)
            .output()
            .await?;
        if !out.status.success() {
            bail!("海报生成失败：{}", String::from_utf8_lossy(&out.stderr));
        }
        Ok(json!({"outputPath":dest}))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let tmp = tempfile::tempdir()?;
        let page = tmp.path().join("poster.html");
        let png = tmp.path().join("poster.png");
        std::fs::write(&page, format!("<meta charset=utf-8><style>*{{box-sizing:border-box}}body{{margin:0;padding:80px;background:{bg};color:{fg};font:40px/1.5 system-ui;overflow-wrap:anywhere;white-space:pre-wrap}}footer{{margin-top:65px;font-size:24px}}</style><main><b>{}</b><p>{}</p><footer>{}</footer></main>",escaped(&orig),escaped(zh),escaped(label)))?;
        let profile = format!("--user-data-dir={}", tmp.path().join("profile").display());
        let url = reqwest::Url::from_file_path(&page).map_err(|_| anyhow!("海报临时路径无效"))?;
        let browsers = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "google-chrome",
            "chromium",
            "chromium-browser",
            "msedge",
        ];
        let height = 520
            + (orig.chars().count() + zh.chars().count()) / 20 * 70
            + (orig.lines().count() + zh.lines().count()) * 60;
        if height > 16000 {
            bail!("选中文字过长，请缩短后生成海报");
        }
        for browser in browsers {
            let out = tokio::process::Command::new(browser)
                .args([
                    "--headless",
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--hide-scrollbars",
                    &profile,
                ])
                .arg(format!("--window-size=1080,{height}"))
                .arg(format!("--screenshot={}", png.display()))
                .arg(url.as_str())
                .output()
                .await;
            match out {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Ok(out) if out.status.success() && png.is_file() => {
                    std::fs::copy(&png, &dest)?;
                    return Ok(json!({"outputPath":dest}));
                }
                _ => bail!("浏览器未能渲染海报"),
            }
        }
        bail!("生成 PNG 海报需要安装 Chrome、Chromium 或 Edge")
    }
}
