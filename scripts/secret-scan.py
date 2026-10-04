#!/usr/bin/env python3
"""Negative scan for secrets/private state in tracked product files."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

PATTERNS = [
    ("pem_private_key", re.compile(rb"BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY")),
    ("github_pat", re.compile(rb"ghp_[A-Za-z0-9]{20,}")),
    ("github_fine_grained", re.compile(rb"github_pat_[A-Za-z0-9_]{20,}")),
    ("aws_access_key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("slack_token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("openai_sk", re.compile(rb"sk-[A-Za-z0-9]{20,}")),
    ("generic_bearer", re.compile(rb"(?i)authorization: bearer [A-Za-z0-9._=+/-]{24,}")),
]

FORBIDDEN_PATH_FRAGMENTS = (
    ".env",
    "node_modules/",
    "__pycache__/",
    "local-coordinator-state.json",
    ".local/",
    "live/evidence/",
    "live/.dev.vars",
    "prototype/.dev.vars",
)

# Placeholders and documented examples are allowed.
ALLOWED_SNIPPETS = (
    b"change-me-admin",
    b"change-me-runner",
    b"adm-get-task-token",
    b"run-get-task-token",
    b"<random>",
    b"ADMIN_TOKEN",
    b"RUNNER_TOKEN",
    b"Bearer $",
    b"Bearer ${",
    b"LOCAL_ARTIFACTS_TOKEN=",
)


def git_tracked(root: Path) -> list[str]:
    out = subprocess.check_output(["git", "-C", str(root), "ls-files"], text=True)
    return [line for line in out.splitlines() if line]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=os.getcwd())
    args = parser.parse_args()
    root = Path(args.root).resolve()
    findings = []
    for rel in git_tracked(root):
        for frag in FORBIDDEN_PATH_FRAGMENTS:
            if frag in rel or rel.startswith(".local/") or rel.endswith(".env"):
                findings.append({"path": rel, "reason": f"forbidden path fragment {frag}"})
                break
        data = (root / rel).read_bytes()
        for name, pattern in PATTERNS:
            for match in pattern.finditer(data):
                snippet = match.group(0)
                if any(allowed in data[max(0, match.start() - 40): match.end() + 40] for allowed in ALLOWED_SNIPPETS):
                    continue
                # Ignore obvious documentation placeholders.
                if b"change-me" in snippet or b"$" in snippet:
                    continue
                findings.append({
                    "path": rel,
                    "reason": name,
                    "offset": match.start(),
                })
    if findings:
        print("SECRET_SCAN_FAIL")
        for item in findings:
            print(f"{item['path']}: {item['reason']}")
        return 1
    print("SECRET_SCAN_PASS")
    print(f"tracked_files={len(git_tracked(root))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
