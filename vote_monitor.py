#!/usr/bin/env python3
"""Read a Weibo vote endpoint from a HAR file and record periodic snapshots."""

import argparse
import csv
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
OUTPUT_DIR = ROOT / "outputs" / "weibo_vote_monitor_20261004"
HISTORY_CSV = DATA_DIR / "vote_history.csv"
CANDIDATES_JSON = DATA_DIR / "candidates.json"
PAYLOAD_JSON = DATA_DIR / "workbook_data.json"
BUILDER = ROOT / "build_workbook.mjs"
DEFAULT_HAR = Path("/Users/rick/Downloads/api.weibo.cn_2026_10_04_17_17_11.har")
DEFAULT_NODE = Path(
    "/Users/rick/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
)


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def load_request_from_har(har_path: Path):
    with har_path.open("r", encoding="utf-8") as handle:
        entries = json.load(handle).get("log", {}).get("entries", [])

    for entry in entries:
        request = entry.get("request", {})
        parsed = urllib.parse.urlsplit(request.get("url", ""))
        if request.get("method") == "GET" and parsed.path == "/vote/aj_index":
            cookie_values = []
            headers = {}
            allowed = {
                "accept",
                "accept-language",
                "cookie",
                "referer",
                "user-agent",
                "wb-lang",
                "wbox-app-language",
                "wbox-color-scheme",
            }
            for item in request.get("headers", []):
                name = item.get("name", "").lower()
                value = item.get("value", "")
                if name not in allowed:
                    continue
                if name == "cookie":
                    cookie_values.append(value)
                else:
                    headers[item.get("name", name)] = value
            if cookie_values:
                headers["Cookie"] = "; ".join(cookie_values)
            return parsed, headers

    raise RuntimeError("HAR 中没有找到 GET /vote/aj_index 请求")


def page_url(parsed, page: int) -> str:
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    found_page = False
    updated = []
    for key, value in query:
        if key == "page":
            updated.append((key, str(page)))
            found_page = True
        else:
            updated.append((key, value))
    if not found_page:
        updated.append(("page", str(page)))
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(updated), parsed.fragment)
    )


def fetch_json(url: str, headers: dict, retries: int = 3) -> dict:
    last_error = None
    for attempt in range(retries):
        try:
            request = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            if attempt + 1 < retries:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"接口请求失败：{last_error}")


def fetch_all_candidates(parsed, headers):
    candidates = {}
    activity_name = "微博投票"
    vote_unit = "票"

    for page in range(1, 101):
        result = fetch_json(page_url(parsed, page), headers)
        if str(result.get("code")) != "100000":
            raise RuntimeError(f"接口返回异常：code={result.get('code')} msg={result.get('msg')}")

        data = result.get("data") or {}
        activity_name = (data.get("hdinfo") or {}).get("name") or activity_name
        page_items = []
        for group in data.get("list") or []:
            items = group.get("listitem") or []
            if isinstance(items, list):
                page_items.extend(items)

        for item in page_items:
            item_id = str(item.get("item_id") or "")
            if not item_id:
                continue
            vote_unit = item.get("votenum_end") or vote_unit
            candidates[item_id] = {
                "item_id": item_id,
                "uid": str(item.get("uid") or ""),
                "name": str(item.get("item_name") or item_id),
                "votes": int(item.get("votenum") or 0),
                "voters": int(item.get("user_num") or 0),
                "rank": int(item.get("rank_num") or 0),
                "intro": str(item.get("item_intro") or ""),
            }

        if not data.get("hasNext"):
            break
        if not page_items:
            raise RuntimeError(f"第 {page} 页为空，但接口仍标记 hasNext")
    else:
        raise RuntimeError("分页超过 100 页，已停止以防异常循环")

    ordered = sorted(
        candidates.values(),
        key=lambda item: (item["rank"] if item["rank"] > 0 else 10**9, -item["votes"], item["name"]),
    )
    if not ordered:
        raise RuntimeError("接口没有返回任何候选人")
    return activity_name, vote_unit, ordered


def load_candidate_metadata():
    if not CANDIDATES_JSON.exists():
        return {"order": [], "items": {}}
    with CANDIDATES_JSON.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_history():
    if not HISTORY_CSV.exists():
        return [], []
    with HISTORY_CSV.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
        fieldnames = list(rows[0].keys()) if rows else []
    return fieldnames, rows


def write_history(fieldnames, rows):
    HISTORY_CSV.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=HISTORY_CSV.name + ".", dir=str(HISTORY_CSV.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temp_name, HISTORY_CSV)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def update_storage(collected_at: str, candidates):
    metadata = load_candidate_metadata()
    order = [str(value) for value in metadata.get("order", [])]
    items = metadata.get("items", {})
    current_ids = {item["item_id"] for item in candidates}

    for candidate in candidates:
        item_id = candidate["item_id"]
        if item_id not in order:
            order.append(item_id)
        items[item_id] = {
            "name": candidate["name"],
            "uid": candidate["uid"],
            "intro": candidate["intro"],
        }

    old_fields, rows = load_history()
    fieldnames = ["collected_at"] + order
    if old_fields and old_fields[0] != "collected_at":
        raise RuntimeError("历史 CSV 首列不是 collected_at，无法安全追加")

    latest_previous = rows[-1] if rows else {}
    snapshot = {"collected_at": collected_at}
    by_id = {item["item_id"]: item for item in candidates}
    for item_id in order:
        snapshot[item_id] = by_id[item_id]["votes"] if item_id in current_ids else ""
    rows.append(snapshot)
    write_history(fieldnames, rows)

    metadata = {"order": order, "items": items}
    atomic_write_text(CANDIDATES_JSON, json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")

    for candidate in candidates:
        previous_value = latest_previous.get(candidate["item_id"], "")
        try:
            candidate["delta"] = candidate["votes"] - int(previous_value)
        except (TypeError, ValueError):
            candidate["delta"] = None

    history_matrix = []
    for row in rows:
        values = [row.get("collected_at", "")]
        for item_id in order:
            raw = row.get(item_id, "")
            values.append(int(raw) if raw not in (None, "") else None)
        history_matrix.append(values)
    return metadata, history_matrix


def build_workbook(activity_name, vote_unit, collected_at, candidates, metadata, history_matrix):
    payload = {
        "activity_name": activity_name,
        "vote_unit": vote_unit,
        "collected_at": collected_at,
        "source": "https://huodong.weibo.cn/vote/aj_index",
        "current": candidates,
        "history": {
            "order": metadata["order"],
            "items": metadata["items"],
            "rows": history_matrix,
        },
    }
    atomic_write_text(PAYLOAD_JSON, json.dumps(payload, ensure_ascii=False) + "\n")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    node = str(DEFAULT_NODE) if DEFAULT_NODE.exists() else "node"
    subprocess.run(
        [node, str(BUILDER), str(PAYLOAD_JSON), str(OUTPUT_DIR)],
        cwd=str(ROOT),
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(description="微博投票票数定时记录器")
    parser.add_argument("--har", type=Path, default=DEFAULT_HAR, help="包含投票接口的 HAR 文件")
    args = parser.parse_args()

    parsed, headers = load_request_from_har(args.har.expanduser().resolve())
    activity_name, vote_unit, candidates = fetch_all_candidates(parsed, headers)
    collected_at = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    metadata, history_matrix = update_storage(collected_at, candidates)
    build_workbook(
        activity_name,
        vote_unit,
        collected_at,
        candidates,
        metadata,
        history_matrix,
    )
    print(
        json.dumps(
            {
                "status": "ok",
                "collected_at": collected_at,
                "activity": activity_name,
                "candidate_count": len(candidates),
                "top": candidates[0],
                "history_snapshots": len(history_matrix),
                "output_dir": str(OUTPUT_DIR),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
