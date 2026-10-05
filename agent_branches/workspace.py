"""Workspace creation utilities for Agent Branches."""

import os
import shutil
import subprocess

def create_workspace(canonical_dir: str, target_dir: str) -> str:
    """
    Creates a new isolated workspace from a canonical git repository.
    
    Tries to use `cp --reflink=always -a` for zero-overhead copy-on-write clones.
    If the filesystem does not support reflinks (or cross-device link), it falls back
    to `git clone --local`, which hardlinks read-only `.git/objects` and copies the working tree.
    
    This ensures no editable source hardlinks are used, avoiding cross-workspace mutation hazards.
    """
    if os.path.exists(target_dir):
        raise ValueError(f"Target directory {target_dir} already exists")

    canonical_dir = os.path.abspath(canonical_dir)
    target_dir = os.path.abspath(target_dir)

    # Attempt reflink copy
    res = subprocess.run(
        ["cp", "--reflink=always", "-a", canonical_dir, target_dir],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if res.returncode == 0:
        return "reflink"

    # Clean up any partial copy
    if os.path.exists(target_dir):
        shutil.rmtree(target_dir)

    # Fallback to git clone --local
    res = subprocess.run(
        ["git", "clone", "--local", canonical_dir, target_dir],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if res.returncode != 0:
        raise RuntimeError(f"Workspace creation failed: {res.stderr}")

    return "clone_local"
