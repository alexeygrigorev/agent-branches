#!/usr/bin/env python3
"""Copy selected product paths from a pinned git tree. Never writes to source."""

from __future__ import annotations

import argparse
import json
import os
import stat
import subprocess
import sys
from pathlib import Path


def run_git(source: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(source), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return result.stdout


def load_policy(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def selected(path: str, policy: dict) -> bool:
    lowered = path.lower()
    for frag in policy["exclude_name_fragments"]:
        if frag in path.split("/"):
            return False
        if frag in lowered and frag in {
            "local-coordinator-state.json",
            ".env",
        }:
            return False
    if path.endswith(".pyc") or path.endswith(".log"):
        return False
    if path in policy["exclude_exact"]:
        return False
    for prefix in policy["exclude_prefixes"]:
        if path.startswith(prefix):
            return False
    if path in policy["include_exact"] or path in policy["include_files"]:
        return True
    for prefix in policy["include_prefixes"]:
        if path.startswith(prefix):
            return True
    return False


def mode_from_ls_tree(mode: str) -> int:
    if mode == "100755":
        return 0o100755
    if mode == "120000":
        return 0o120000
    return 0o100644


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default="/home/alexey/git/agent-branches-integration")
    parser.add_argument("--dest", default=os.getcwd())
    parser.add_argument("--pin", default=None, help="Source commit SHA; default HEAD of source")
    parser.add_argument(
        "--policy",
        default=str(Path(__file__).with_name("extract-policy.json")),
    )
    parser.add_argument("--manifest", default="docs/SOURCE-PROVENANCE.md")
    parser.add_argument("--raw-manifest", default=".local/raw/source-pin.json")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    dest = Path(args.dest).resolve()
    policy = load_policy(Path(args.policy))

    if not source.is_dir():
        print(f"error: source missing: {source}", file=sys.stderr)
        return 2

    pin = (args.pin or run_git(source, "rev-parse", "HEAD")).strip()
    tree = run_git(source, "rev-parse", f"{pin}^{{tree}}").strip()
    branch = run_git(source, "rev-parse", "--abbrev-ref", "HEAD").strip()
    subject = run_git(source, "show", "-s", "--format=%s", pin).strip()
    committer_date = run_git(source, "show", "-s", "--format=%cI", pin).strip()
    remote = run_git(source, "remote", "get-url", "origin").strip()

    ls = run_git(source, "ls-tree", "-r", pin)
    entries = []
    for line in ls.splitlines():
        meta, path = line.split("\t", 1)
        mode, obj_type, sha = meta.split()
        if obj_type != "blob":
            continue
        if selected(path, policy):
            entries.append({"path": path, "mode": mode, "sha": sha})

    entries.sort(key=lambda item: item["path"])
    if not entries:
        print("error: no selected paths", file=sys.stderr)
        return 2

    written = []
    for item in entries:
        path = item["path"]
        target = dest / path
        target.parent.mkdir(parents=True, exist_ok=True)
        blob = subprocess.run(
            ["git", "-C", str(source), "cat-file", "blob", f"{pin}:{path}"],
            check=True,
            stdout=subprocess.PIPE,
        ).stdout
        if item["mode"] == "120000":
            if target.exists() or target.is_symlink():
                target.unlink()
            target.symlink_to(blob.decode("utf-8"))
        else:
            target.write_bytes(blob)
            os.chmod(target, mode_from_ls_tree(item["mode"]) & 0o777)
        written.append(item)

    dest_gitignore = dest / ".gitignore"
    extra_ignore = [
        ".local/",
        ".env",
        ".env.*",
        "!.env.example",
        "node_modules/",
        ".wrangler/",
        ".build/",
        "*.log",
        "__pycache__/",
        "live/.dev.vars",
        "live/work/",
        "live/state/",
        "live/artifacts/",
        "live/evidence/",
        "prototype/.dev.vars",
        "prototype/.sidecar/",
        "*.pyc",
    ]
    existing = dest_gitignore.read_text(encoding="utf-8") if dest_gitignore.exists() else ""
    merged = existing.strip().splitlines() if existing.strip() else []
    for line in extra_ignore:
        if line not in merged:
            merged.append(line)
    dest_gitignore.write_text("\n".join(merged) + "\n", encoding="utf-8")

    raw_path = dest / args.raw_manifest
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw = {
        "source_repo": str(source),
        "source_remote": remote,
        "source_commit": pin,
        "source_tree": tree,
        "source_branch": branch,
        "source_subject": subject,
        "source_committer_date": committer_date,
        "path_count": len(written),
        "paths": written,
        "policy": policy,
        "never_copied_untracked": policy.get("never_copy_untracked", []),
    }
    raw_path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")

    manifest = dest / args.manifest
    manifest.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Source provenance",
        "",
        "This repository is a product-only extraction. It does not replay the",
        "experiment log history from the competition workspace.",
        "",
        "## Pinned source",
        "",
        f"- Local original (read-only): `{source}`",
        f"- Source remote: `{remote}`",
        f"- Source branch at extract time: `{branch}`",
        f"- Source commit: `{pin}`",
        f"- Source tree: `{tree}`",
        f"- Committer date: `{committer_date}`",
        f"- Subject: {subject}",
        "",
        "Recover the original by checking out that commit in the source remote",
        "or the preserved local worktree. Do not treat this private product repo",
        "as a mirror of experiment history.",
        "",
        f"Selected product paths: **{len(written)}**",
        "",
        "| Path | Mode | Blob SHA |",
        "| --- | --- | --- |",
    ]
    for item in written:
        lines.append(f"| `{item['path']}` | `{item['mode']}` | `{item['sha']}` |")
    lines.append("")
    manifest.write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps({
        "source_commit": pin,
        "source_tree": tree,
        "path_count": len(written),
        "manifest": str(manifest),
        "raw_manifest": str(raw_path),
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
