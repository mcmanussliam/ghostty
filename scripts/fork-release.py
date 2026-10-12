#!/usr/bin/env python3
"""Prepare a stable upstream rebase without rewriting published branches."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


UPSTREAM = "https://github.com/ghostty-org/ghostty.git"
MANIFEST = Path("fork/upstream.json")


def git(repo, *args, check=True):
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def validate_version(tag, revision):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Use an exact stable upstream tag such as v1.3.1.")
    if revision < 1:
        raise ValueError("The fork revision must be positive.")


def target_ref(tag):
    return f"refs/remotes/upstream/tags/{tag}"


def release_branch(tag, revision):
    return f"release/ghostty-{tag}-mcm.{revision}"


def ensure_no_rebase(repo):
    for name in ("rebase-merge", "rebase-apply"):
        path = Path(git(repo, "rev-parse", "--git-path", name).stdout.strip())
        if not path.is_absolute():
            path = repo / path
        if path.exists():
            raise ValueError("Finish or abort the rebase before recording its base.")


def record(repo, tag, revision):
    ensure_no_rebase(repo)
    branch = git(repo, "branch", "--show-current").stdout.strip()
    if branch != release_branch(tag, revision):
        raise ValueError("Record the base from the matching release worktree.")
    commit = git(repo, "rev-parse", f"{target_ref(tag)}^{{commit}}").stdout.strip()
    if git(repo, "merge-base", "--is-ancestor", commit, "HEAD", check=False).returncode:
        raise ValueError("The candidate is not based on the requested upstream tag.")
    manifest = json.loads((repo / MANIFEST).read_text())
    if manifest["repository"] != UPSTREAM:
        raise ValueError("The manifest must identify ghostty-org/ghostty.")
    manifest.update(commit=commit, tag=tag, fork_revision=revision)
    (repo / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Recorded {tag} at {commit}. Review and commit {MANIFEST}.")


def prepare(repo, tag, revision):
    if git(repo, "status", "--porcelain").stdout.strip():
        raise ValueError("Commit or stash changes before preparing a release.")
    if git(repo, "rev-parse", "--is-shallow-repository").stdout.strip() == "true":
        raise ValueError("Full history is required; fetch it with git fetch --unshallow.")
    manifest = json.loads((repo / MANIFEST).read_text())
    if manifest["repository"] != UPSTREAM or not re.fullmatch(r"[0-9a-f]{40}", manifest["commit"]):
        raise ValueError("The manifest must contain a valid Ghostty upstream base.")
    old_base = manifest["commit"]
    git(repo, "merge-base", "--is-ancestor", old_base, "HEAD")
    branch = release_branch(tag, revision)
    path = repo.parent / f"{repo.name}-{tag}-mcm.{revision}"
    if path.exists() or git(repo, "show-ref", "--verify", f"refs/heads/{branch}", check=False).returncode == 0:
        raise ValueError("That release worktree or branch already exists; choose a new revision.")

    # Fetch by explicit URL so a locally configured upstream remote cannot
    # silently redirect the release base to a different repository.
    git(repo, "fetch", UPSTREAM, f"refs/tags/{tag}:{target_ref(tag)}")
    new_base = git(repo, "rev-parse", f"{target_ref(tag)}^{{commit}}").stdout.strip()
    git(repo, "worktree", "add", "-b", branch, str(path), "HEAD")
    result = git(path, "rebase", "--onto", new_base, old_base, check=False)
    print(f"Release worktree: {path}")
    if result.returncode:
        print(result.stdout + result.stderr, file=sys.stderr)
        print("Resolve conflicts in that worktree and run git rebase --continue.", file=sys.stderr)
        print(f"Then run: python3 scripts/fork-release.py record {tag} --revision {revision}", file=sys.stderr)
        return result.returncode
    record(path, tag, revision)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "record"))
    parser.add_argument("tag")
    parser.add_argument("--revision", type=int, default=1)
    args = parser.parse_args()
    try:
        validate_version(args.tag, args.revision)
        repo = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip())
        if args.action == "prepare":
            return prepare(repo, args.tag, args.revision)
        record(repo, args.tag, args.revision)
        return 0
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Release preparation failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
