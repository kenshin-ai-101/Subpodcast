#!/usr/bin/env python3
"""Builds public/dict/en.json for Subpodcast English learning mode.

Source: ECDICT (https://github.com/skywind3000/ECDICT, MIT License, (c) Linwei).
Download ecdict.csv and run:

    python3 scripts/build-dict.py /path/to/ecdict.csv

Kept: lowercase single words with an exam tag or top-60k frequency rank.
Each entry is [phonetic, meaning, tags, rank]; tags are bits in TAG_BITS order.
"forms" maps inflected forms to their lemma.
"""
import csv, json, re, sys
from pathlib import Path

TAG_BITS = ["zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"]
MAX_RANK = 60000
FORM_OF = re.compile(r"^([a-z]+)的(?:过去式|过去分词|现在分词|现在式|复数|第三人称|比较级|最高级)")
WORD = re.compile(r"^[a-z][a-z'-]*[a-z]$|^[a-z]$")


def meaning(tr: str) -> str:
    lines = [l.strip() for l in tr.replace("\\n", "\n").split("\n") if l.strip() and not l.startswith("[网络]")]
    out, total = [], 0
    for l in lines[:3]:
        l = re.sub(r"\s+", " ", l)
        if total + len(l) > 70 and out:
            break
        out.append(l)
        total += len(l)
    return "\n".join(out)


def main(src: str) -> None:
    csv.field_size_limit(10**8)
    rows = {}
    with open(src, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if WORD.match(row["word"]):
                rows[row["word"]] = row
    entries, forms, cands = {}, {}, {}
    for w, row in rows.items():
        ex = dict(p.split(":", 1) for p in row["exchange"].split("/") if ":" in p)
        lemma = ex.get("0")
        if lemma and lemma != w and lemma in rows:
            forms[w] = lemma
            continue
        m = FORM_OF.match(row["translation"])
        if m and m.group(1) in rows and m.group(1) != w:
            forms[w] = m.group(1)
            continue
        tags = row["tag"].split()
        bits = sum(1 << TAG_BITS.index(t) for t in tags if t in TAG_BITS)
        ranks = [int(r) for r in (row["frq"], row["bnc"]) if r and r != "0"]
        rank = min(ranks) if ranks else 0
        if not bits and not (0 < rank <= MAX_RANK):
            continue
        tr = meaning(row["translation"])
        if not tr:
            continue
        entries[w] = [row["phonetic"].replace("ә", "ə"), tr, bits, rank]
        for k, v in ex.items():
            if k in "pdi3rst" and v and v != w:
                for form in v.split(","):
                    if WORD.match(form):
                        cands.setdefault(form, []).append(w)
    by_rank = lambda l: entries[l][3] or 10**9
    for form, ls in cands.items():
        options = [l for l in ls if l in entries] + ([forms[form]] if forms.get(form) in entries else [])
        if options:
            forms[form] = min(options, key=by_rank)
    forms = {f: l for f, l in forms.items() if l in entries and f not in entries}
    out = Path(__file__).resolve().parent.parent / "public" / "dict" / "en.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"v": 1, "tags": TAG_BITS, "words": entries, "forms": forms}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"{len(entries)} words, {len(forms)} forms, {out.stat().st_size / 1e6:.1f} MB -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
