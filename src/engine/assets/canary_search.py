"""Galley's bridge to Canary's search runtime.

Runs Canary discoveries (OpenAlex search with Canary's receipts, key handling
and rate-limit backoff) and returns each query's first page of results in the
provider's own order, with abstracts. Galley only asks and reads; the
searching is Canary's.

Each query has a workspace of its own and is searched once: Canary resumes
any query whose results run past one page, and galley never needs more than
the first page, so a finished query's workspace is never searched again.

stdin:  {"question": str, "items": [{"workspace": str, "id": str, "search": str}], "top": int}
stdout: {"retry_not_before": epoch|null, "queries": {id: {"done": bool, "matched": int|null, "status": int|null, "results": [...]}}}
"""
import contextlib
import json
import sys
import time
from pathlib import Path

from canary import coverage_runtime as runtime


def work_record(work):
    location = work.get("primary_location") or {}
    source = location.get("source") or {}
    return {
        "id": work["id"].rsplit("/", 1)[-1],
        "doi": work.get("doi"),
        "title": work.get("display_name") or work.get("title") or "",
        "year": work.get("publication_year"),
        "venue": source.get("display_name"),
        "type": work.get("type"),
        "authors": [(a.get("author") or {}).get("display_name") for a in work.get("authorships", [])][:12],
        "abstract": runtime.abstract_text(work.get("abstract_inverted_index")) or "",
        "oa": (work.get("open_access") or {}).get("is_oa"),
        "url": work.get("id"),
    }


def first_page(workspace, query_id):
    return workspace / "search-responses" / f"{query_id}-0001.json"


def main():
    request = json.load(sys.stdin)
    top = int(request.get("top", 15))
    out, retry = {}, None
    for item in request["items"]:
        workspace = Path(item["workspace"])
        workspace.mkdir(parents=True, exist_ok=True)
        page = first_page(workspace, item["id"])
        state = {}
        if not page.exists() and retry is None:
            plan = {"question": request["question"], "concepts": [], "outcomes": [], "conditions": [],
                    "coverage_aspects": [], "eligibility": {}, "queries": [{"id": item["id"], "search": item["search"]}]}
            plan_path = workspace / "galley-plan.json"
            plan_path.write_text(json.dumps(plan))
            # Canary reports its own progress on stdout; keep stdout for the answer.
            with contextlib.redirect_stdout(sys.stderr):
                progress = runtime.discover(workspace, plan_path, pages=1)
            state = progress["queries"].get(item["id"], {})
            backoff = progress.get("backoff") or {}
            if backoff.get("active") and backoff.get("retry_not_before_epoch", 0) > time.time():
                retry = backoff["retry_not_before_epoch"]
        elif page.exists():
            saved = workspace / "search-progress.json"
            state = json.loads(saved.read_text())["queries"].get(item["id"], {}) if saved.exists() else {}
        results = []
        if page.exists():
            body = json.loads(page.read_text())
            results = [work_record(w) for w in body.get("results", [])[:top]]
        out[item["id"]] = {"done": page.exists(), "matched": state.get("matched"), "status": 200 if page.exists() else state.get("failure_status"), "results": results}
    print(json.dumps({"retry_not_before": retry, "queries": out}))


if __name__ == "__main__":
    main()
