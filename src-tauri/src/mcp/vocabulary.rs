use super::*;
use chrono::Local;

static DICT: once_cell::sync::Lazy<Value> = once_cell::sync::Lazy::new(|| {
    serde_json::from_str(include_str!("../../../public/dict/en.json")).expect("bundled dictionary")
});

fn lookup(word: &str) -> Result<Value> {
    let clean = word.replace(['’', '‘'], "'");
    let clean = clean.trim_matches('\'');
    let clean = clean.strip_suffix("'s").unwrap_or(clean);
    let lemma = if DICT["words"].get(clean).is_some() {
        clean
    } else {
        DICT["forms"][clean].as_str().unwrap_or(clean)
    };
    let row = DICT["words"]
        .get(lemma)
        .ok_or_else(|| anyhow!("离线词典未收录 {word}"))?;
    let bits = row[2].as_u64().unwrap_or(0);
    let labels = [
        "中考", "高考", "四级", "六级", "考研", "托福", "雅思", "GRE",
    ];
    let label = labels
        .iter()
        .enumerate()
        .find(|(i, _)| bits & (1 << i) != 0)
        .map(|(_, s)| *s)
        .unwrap_or("");
    Ok(
        json!({"lemma":lemma,"ipa":row[0],"meaning":row[1],"tags":bits,"tagLabel":label,"rank":row[3]}),
    )
}

fn schedule(card: &Value, rating: &str, now: i64) -> Result<Value> {
    let grade = ["again", "hard", "good", "easy"]
        .iter()
        .position(|g| *g == rating)
        .ok_or_else(|| anyhow!("rating 须为 again、hard、good 或 easy"))?
        + 1;
    let tmp = tempfile::tempdir()?;
    let algorithm = r#"function review(f, args) {
        const card = JSON.parse(args[0]);
        card.due = new Date(card.due);
        if (card.last_review) card.last_review = new Date(card.last_review);
        const next = f.fsrs({enable_fuzz:true}).next(card, new Date(Number(args[1])), Number(args[2])).card;
        return JSON.stringify({...next, due:+next.due, last_review:+next.last_review});
    }"#;
    let engine = include_str!("../../../node_modules/ts-fsrs/dist/index.umd.js");
    let mut command;
    let path = tmp.path().join("review.cjs");
    #[cfg(target_os = "macos")]
    {
        std::fs::write(
            &path,
            format!("{engine}\n{algorithm}\nfunction run(args) {{return review(FSRS,args)}}"),
        )?;
        command = std::process::Command::new("/usr/bin/osascript");
        command.args(["-l", "JavaScript"]);
    }
    #[cfg(not(target_os = "macos"))]
    {
        std::fs::write(
            &path,
            format!(
                "{engine}\n{algorithm}\nconsole.log(review(module.exports,process.argv.slice(2)))"
            ),
        )?;
        command = std::process::Command::new("node");
    }
    let out = command
        .arg(path)
        .arg(card.to_string())
        .arg(now.to_string())
        .arg(grade.to_string())
        .output()?;
    if !out.status.success() {
        bail!("FSRS 调度失败：{}", String::from_utf8_lossy(&out.stderr));
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

pub(super) fn run(ctx: &McpCtx, name: &str, args: &Value) -> Result<Value> {
    let word = args["word"].as_str().unwrap_or("").trim().to_lowercase();
    if name == "vocab_lookup" {
        return lookup(&word);
    }
    let mut conn = ctx.db.lock().map_err(|e| anyhow!("{e}"))?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let day = Local::now().format("%Y-%m-%d").to_string();
    let now = Local::now().timestamp_millis();
    let mut book: Value = match db::get_blob(&tx, "learn", "words")? {
        Some(raw) => serde_json::from_str(&raw)?,
        None => json!({"v":1,"words":{},"day":day,"newToday":0,"log":{},"known":{}}),
    };
    let words = book["words"]
        .as_object()
        .ok_or_else(|| anyhow!("生词本格式错误"))?;
    let id = args["id"].as_str().unwrap_or("").trim().to_lowercase();
    if name == "vocab_list"
        || (name == "vocab_review_due" && id.is_empty() && args["rating"].is_null())
    {
        let due = name == "vocab_review_due" || args["dueOnly"].as_bool() == Some(true);
        let mut rows: Vec<_> = words
            .values()
            .filter(|w| !due || w["card"]["due"].as_i64().unwrap_or(0) <= now)
            .collect();
        rows.sort_by_key(|w| w["card"]["due"].as_i64());
        return Ok(json!(rows));
    }
    let result = if name == "vocab_add" {
        if word.is_empty() {
            bail!("请提供单词");
        }
        let entry = lookup(&word).unwrap_or(Value::Null);
        let word = entry["lemma"].as_str().unwrap_or(&word);
        if let Some(saved) = words.get(word) {
            return Ok(saved.clone());
        }
        let saved = json!({"id":word,"word":word,"ipa":entry["ipa"].as_str().unwrap_or(""),
            "meaning":args["meaning"].as_str().or(entry["meaning"].as_str()).unwrap_or(""),
            "sentence":args["sentence"].as_str().unwrap_or(""),"episodeId":"","episodeTitle":"",
            "start":0,"end":0,"added":now,"card":{"due":now,"stability":0,"difficulty":0,
            "scheduled_days":0,"learning_steps":0,"reps":0,"lapses":0,"state":0}});
        book["words"][word] = saved.clone();
        saved
    } else {
        let saved = words
            .get(&id)
            .ok_or_else(|| anyhow!("请提供生词本中的单词 ID"))?;
        let rating = args["rating"]
            .as_str()
            .ok_or_else(|| anyhow!("请提供 rating"))?;
        let was_new = saved["card"]["state"] == 0;
        let next = schedule(&saved["card"], rating, now)?;
        book["words"][&id]["card"] = next;
        let today = if book["day"] == day {
            book["newToday"].as_i64().unwrap_or(0)
        } else {
            0
        };
        book["newToday"] = json!(today + i64::from(was_new));
        book["day"] = json!(day);
        let log = &mut book["log"][&day];
        if log.is_null() {
            *log = json!({"r":0,"a":0,"ids":[]});
        }
        log["r"] = json!(log["r"].as_i64().unwrap_or(0) + 1);
        log["a"] = json!(log["a"].as_i64().unwrap_or(0) + i64::from(rating == "again"));
        let ids = log["ids"]
            .as_array_mut()
            .ok_or_else(|| anyhow!("复习记录格式错误"))?;
        if !ids.contains(&json!(id)) {
            ids.push(json!(id));
        }
        book["words"][&id].clone()
    };
    db::set_blob(&tx, "learn", "words", &book.to_string())?;
    tx.commit()?;
    Ok(result)
}
