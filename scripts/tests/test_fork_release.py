import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "fork-release.py"
SPEC = importlib.util.spec_from_file_location("fork_release", SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ForkReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        self.run_git(self.upstream, "init", "-b", "main")
        self.configure(self.upstream)
        (self.upstream / "core.txt").write_text("old core\n")
        self.commit(self.upstream, "upstream base")
        self.base = self.run_git(self.upstream, "rev-parse", "HEAD")
        self.repo = self.root / "fork"
        self.run_git(self.root, "clone", str(self.upstream), str(self.repo))
        self.configure(self.repo)
        (self.repo / release.MANIFEST).parent.mkdir()
        (self.repo / release.MANIFEST).write_text(json.dumps({
            "repository": str(self.upstream), "commit": self.base,
            "tag": None, "fork_revision": 0,
        }))
        (self.repo / "feature.txt").write_text("fork feature\n")
        self.commit(self.repo, "fork patch")
        (self.upstream / "core.txt").write_text("new stable core\n")
        self.commit(self.upstream, "stable upstream")
        self.run_git(self.upstream, "tag", "v1.3.1")
        self.new_base = self.run_git(self.upstream, "rev-parse", "HEAD")

    def run_git(self, repo, *args):
        result = subprocess.run(["git", "-C", str(repo), *args], check=True,
                                text=True, capture_output=True)
        return result.stdout.strip()

    def configure(self, repo):
        self.run_git(repo, "config", "user.name", "Release Test")
        self.run_git(repo, "config", "user.email", "release-test@example.invalid")

    def commit(self, repo, message):
        self.run_git(repo, "add", ".")
        self.run_git(repo, "commit", "-m", message)

    def test_rebase_preserves_patch_and_original_branch(self):
        before = self.run_git(self.repo, "rev-parse", "HEAD")
        with patch.object(release, "UPSTREAM", str(self.upstream)):
            self.assertEqual(release.prepare(self.repo, "v1.3.1", 1), 0)
        candidate = self.root / "fork-v1.3.1-mcm.1"
        self.assertEqual((candidate / "core.txt").read_text(), "new stable core\n")
        self.assertEqual((candidate / "feature.txt").read_text(), "fork feature\n")
        self.assertEqual(self.run_git(self.repo, "rev-parse", "HEAD"), before)
        manifest = json.loads((candidate / release.MANIFEST).read_text())
        self.assertEqual(manifest["commit"], self.new_base)
        self.assertEqual(manifest["tag"], "v1.3.1")
        self.assertEqual(manifest["fork_revision"], 1)

    def test_dirty_checkout_is_rejected(self):
        (self.repo / "feature.txt").write_text("uncommitted\n")
        with self.assertRaisesRegex(ValueError, "Commit or stash"):
            release.prepare(self.repo, "v1.3.1", 1)

    def test_existing_revision_is_not_replaced(self):
        with patch.object(release, "UPSTREAM", str(self.upstream)):
            self.assertEqual(release.prepare(self.repo, "v1.3.1", 1), 0)
            with self.assertRaisesRegex(ValueError, "already exists"):
                release.prepare(self.repo, "v1.3.1", 1)

    def test_record_requires_matching_release_branch(self):
        with self.assertRaisesRegex(ValueError, "matching release worktree"):
            release.record(self.repo, "v1.3.1", 1)

    def test_conflicts_leave_candidate_and_original_intact(self):
        (self.repo / "core.txt").write_text("fork core\n")
        self.commit(self.repo, "conflicting fork patch")
        before = self.run_git(self.repo, "rev-parse", "HEAD")
        with patch.object(release, "UPSTREAM", str(self.upstream)):
            self.assertNotEqual(release.prepare(self.repo, "v1.3.1", 1), 0)
        candidate = self.root / "fork-v1.3.1-mcm.1"
        self.assertIn("UU core.txt", self.run_git(candidate, "status", "--porcelain"))
        self.assertEqual(self.run_git(self.repo, "rev-parse", "HEAD"), before)
        with self.assertRaisesRegex(ValueError, "Finish or abort"):
            release.record(candidate, "v1.3.1", 1)

    def test_only_stable_tags_and_positive_revisions(self):
        for tag in ("tip", "main", "v1.3.1-rc1", "--help", "1.3.1"):
            with self.assertRaises(ValueError):
                release.validate_version(tag, 1)
        with self.assertRaises(ValueError):
            release.validate_version("v1.3.1", 0)
        release.validate_version("v1.3.1", 1)


if __name__ == "__main__":
    unittest.main()
