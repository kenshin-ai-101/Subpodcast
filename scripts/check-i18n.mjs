#!/usr/bin/env node
/**
 * 扫描 src/ 下所有 t("...") / tNow("...") 静态词条，校验 src/locales/{zh-TW,en}.json 完整度。
 * 用法: node scripts/check-i18n.mjs [--strict]
 */
import fs from "node:fs";
import path from "node:path";

const strict = process.argv.includes("--strict");
const root = process.cwd();
const srcDir = path.join(root, "src");
const locales = ["zh-TW", "en"];

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "__tests__" || ent.name === "locales") continue;
      walk(full, out);
    } else if (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const used = new Set();
const RE = /\b(?:t|tNow)\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g;
for (const file of walk(srcDir)) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(RE)) {
    used.add(m[1]);
  }
}

const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
const placeholdersOf = (s) => [...new Set([...String(s).matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort().join(",");

let failed = false;
for (const loc of locales) {
  const dictPath = path.join(srcDir, "locales", `${loc}.json`);
  const dict = JSON.parse(fs.readFileSync(dictPath, "utf8"));
  const missing = [...used].filter((k) => !(k in dict) || !String(dict[k]).trim());
  const badVars = Object.entries(dict)
    .filter(([k, v]) => placeholdersOf(k) !== placeholdersOf(v))
    .map(([k, v]) => `${k} => ${v}`);
  const extra = Object.keys(dict).filter((k) => !used.has(k));
  console.log(`[i18n] ${loc}: ${used.size} used, ${missing.length} missing, ${badVars.length} badVars, ${extra.length} extra`);
  if (missing.length) {
    failed = true;
    console.error(`  Missing in ${loc}:`, missing);
  }
  if (badVars.length) {
    failed = true;
    console.error(`  Placeholder mismatch in ${loc}:`, badVars);
  }
  if (strict && extra.length) {
    console.warn(`  Note (${loc} extra/dynamic keys): ${extra.length}`);
  }
}

if (failed && strict) {
  process.exit(1);
}
