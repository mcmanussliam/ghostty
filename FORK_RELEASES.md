# Personal fork releases

This fork keeps the Ghostty name and uses `io.github.mcmanussliam.ghostty`
for the macOS app. Releases belong to `mcmanussliam/ghostty`; upstream
Ghostty release workflows and update feeds must not publish or update this app.

## Version policy

Base releases on an explicit stable Ghostty tag, never a moving `main` or `tip`.
Use `mcm/vX.Y.Z-N` for fork release tags, where `vX.Y.Z` is the upstream tag
and `N` is this fork's positive revision number for that version. For example,
`mcm/v1.3.1-1` identifies the first fork release based on Ghostty v1.3.1.
The example is a naming convention, not a claim that this fork is based on it.

`fork/upstream.json` records the exact upstream commit, tag, and fork revision.
The initial manifest records the development snapshot already merged into
this repository. Its null tag and revision zero mean it is not a release.
The first stable rebase may move back from this snapshot and require conflicts
to be resolved or newer feature APIs to be adapted.

## Preparing a new version

Keep `main` as the development branch. Make releases in new worktrees so
rebasing a candidate does not rewrite published branches or release tags.
Do not sync upstream `main` into a stable release branch.

From a clean checkout with full Git history:

```sh
python3 scripts/fork-release.py prepare vX.Y.Z --revision 1
```

The helper fetches that exact upstream tag, creates a new branch and worktree,
and rebases the fork commits after the recorded upstream base onto the tag.
It does not push, merge, create a release tag, or publish artifacts. Review the
printed worktree path. If the rebase stops, resolve the conflicts there, run
`git rebase --continue`, and then record the successful base:

```sh
python3 scripts/fork-release.py record vX.Y.Z --revision 1
```

Run `record` from the release worktree. It checks that the fetched tag is an
ancestor of the candidate and that no rebase is in progress. Commit the
manifest update with the candidate after reviewing the result. Use a new
revision and branch for a rebuild; never replace an existing release tag.

Before publication, compare the patch stack with the previous release using
`git range-diff`, check that fork changes survived, and verify the upstream
tag and commit in the manifest. Resolve conflicts according to the upstream
version's APIs rather than retaining newer APIs that no longer compile.

## macOS validation and packaging

Use the Zig version required by that checkout's `build.zig.zon` and the Xcode
version required by its `HACKING.md`. From the repository root:

```sh
zig build -Demit-macos-app=false
swiftlint lint --strict
macos/build.nu --action test
macos/build.nu --configuration ReleaseLocal
```

CLI test runs skip UI tests. Run the workspace and palette UI tests in Xcode,
then check Finder services, Dock behavior, AppleScript, config loading, pane
focus, and running this app alongside official Ghostty. Verify bundle IDs and
that manual updates point to this fork before publishing.

The Fork macOS workflow provides a hosted build and unit-test path independent
of upstream's private runners. Its build artifact is a local, ad-hoc signed
app for testing, not a notarized distribution. Signing and notarization need
this fork's own Apple Developer identity before distributing to other people.

Only tag and publish after native validation passes. Release notes must state
the upstream version and commit, fork revision, changes, and test results.
Keep official Ghostty credits and license notices. Install fork releases
manually until a separately signed fork update feed is implemented.
