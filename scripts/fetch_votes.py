#!/usr/bin/env python3
"""Fetch all Weibo vote pages and append a compact dashboard snapshot."""

import argparse
import json
import os
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "docs" / "data" / "history.json"


def atomic_write(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def request_from_har(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        entries = json.load(handle).get("log", {}).get("entries", [])
    for entry in entries:
        request = entry.get("request", {})
        parsed = urllib.parse.urlsplit(request.get("url", ""))
        if request.get("method") == "GET" and parsed.path == "/vote/aj_index":
            headers = {}
            for item in request.get("headers", []):
                name = item.get("name", "")
                if name.startswith(":") or name.lower() in {"cookie", "accept-encoding", "content-length", "host"}:
                    continue
                headers[name] = item.get("value", "")
            return {"url": request["url"], "headers": headers}
    raise RuntimeError("HAR 中没有找到 GET /vote/aj_index")


def load_request(args) -> dict:
    encoded = os.environ.get("WEIBO_REQUEST_JSON")
    if encoded:
        request = json.loads(encoded)
    elif args.har:
        request = request_from_har(args.har.expanduser().resolve())
    else:
        raise RuntimeError("缺少 WEIBO_REQUEST_JSON 或 --har")
    if not request.get("url") or not isinstance(request.get("headers"), dict):
        raise RuntimeError("请求配置格式不完整")
    return request


def with_page(url: str, page: int) -> str:
    parsed = urllib.parse.urlsplit(url)
    pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    output = []
    found = False
    for key, value in pairs:
        if key == "page":
            output.append((key, str(page)))
            found = True
        else:
            output.append((key, value))
    if not found:
        output.append(("page", str(page)))
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(output), ""))


def fetch(url: str, headers: dict) -> dict:
    last_error = None
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"微博接口请求失败：{last_error}")


def fetch_all(request_config: dict):
    items = {}
    activity = "微博投票"
    unit = "票"
    for page in range(1, 101):
        response = fetch(with_page(request_config["url"], page), request_config["headers"])
        if str(response.get("code")) != "100000":
            raise RuntimeError(f"微博接口返回 code={response.get('code')} msg={response.get('msg')}")
        data = response.get("data") or {}
        activity = (data.get("hdinfo") or {}).get("name") or activity
        page_items = []
        for group in data.get("list") or []:
            if isinstance(group.get("listitem"), list):
                page_items.extend(group["listitem"])
        for item in page_items:
            item_id = str(item.get("item_id") or "")
            if not item_id:
                continue
            unit = item.get("votenum_end") or unit
            items[item_id] = {
                "id": item_id,
                "name": str(item.get("item_name") or item_id),
                "uid": str(item.get("uid") or ""),
                "intro": str(item.get("item_intro") or ""),
                "votes": int(item.get("votenum") or 0),
                "voters": int(item.get("user_num") or 0),
                "rank": int(item.get("rank_num") or 0),
            }
        if not data.get("hasNext"):
            break
        if not page_items:
            raise RuntimeError(f"第 {page} 页没有数据但 hasNext=1")
    else:
        raise RuntimeError("分页超过 100 页")
    ordered = sorted(items.values(), key=lambda item: (item["rank"] or 10**9, -item["votes"]))
    if not ordered:
        raise RuntimeError("接口没有返回候选人")
    return activity, unit, ordered


def load_history(path: Path) -> dict:
    if not path.exists():
        return {"schema_version": 1, "activity": "", "unit": "票", "candidate_order": [], "candidates": {}, "snapshots": []}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def update_history(path: Path, activity: str, unit: str, current: list) -> bool:
    history = load_history(path)
    order = [str(item) for item in history.get("candidate_order", [])]
    candidates = history.get("candidates", {})
    old_length = len(order)
    for item in current:
        if item["id"] not in order:
            order.append(item["id"])
        candidates[item["id"]] = {"name": item["name"], "uid": item["uid"], "intro": item["intro"]}
    if len(order) > old_length:
        for snapshot in history.get("snapshots", []):
            snapshot["votes"].extend([None] * (len(order) - len(snapshot["votes"])))
            snapshot["voters"].extend([None] * (len(order) - len(snapshot["voters"])))

    by_id = {item["id"]: item for item in current}
    votes = [by_id[item_id]["votes"] if item_id in by_id else None for item_id in order]
    voters = [by_id[item_id]["voters"] if item_id in by_id else None for item_id in order]
    timestamp = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds")
    snapshots = history.get("snapshots", [])
    should_append = True
    if snapshots and snapshots[-1].get("votes") == votes:
        elapsed = datetime.fromisoformat(timestamp) - datetime.fromisoformat(snapshots[-1]["timestamp"])
        should_append = elapsed.total_seconds() >= 20 * 60
    if should_append:
        snapshots.append({"timestamp": timestamp, "votes": votes, "voters": voters})

    history.update({
        "schema_version": 1,
        "activity": activity,
        "unit": unit,
        "candidate_order": order,
        "candidates": candidates,
        "snapshots": snapshots,
    })
    atomic_write(path, history)
    return should_append


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--har", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    request_config = load_request(args)
    activity, unit, current = fetch_all(request_config)
    appended = update_history(args.output, activity, unit, current)
    print(json.dumps({
        "status": "ok",
        "activity": activity,
        "candidate_count": len(current),
        "snapshot_appended": appended,
        "output": str(args.output),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
