# Contributing to rlxapp

Thanks for your interest in rlxapp! It is an open-source project, and
contributions are welcome.

**The code is coming soon.** `main` holds the README and the repo's own files
for now. The app is built on the release train, `rc/0.1.0`, and reaches `main`
when 0.1.0 is released.

## Where to start

- **Ask when unsure.**
  [Discussions, Q&A](https://github.com/AISquare-Studio/rlxapp/discussions/categories/q-a)
  is the place for "where does this live?" and "would you take a PR that…?".
- **Share an idea** that is not yet a feature in
  [Discussions, Ideas](https://github.com/AISquare-Studio/rlxapp/discussions/categories/ideas).
- **Know where a change belongs.** rlxapp is the desktop face of
  [rlx](https://github.com/AISquare-Studio/rlx): rlx runs the agents, and rlxapp
  shows them and lets you steer them. A change to how agents run, or to what
  they remember, probably belongs in rlx; its
  [CONTRIBUTING.md](https://github.com/AISquare-Studio/rlx/blob/main/CONTRIBUTING.md)
  says how.
- **Keep a PR to one change**, with a test that fails without it.

## Where a pull request goes

- **Into the release train.** Branch from `rc/<version>` (now `rc/0.1.0`) and
  open the PR into it, not into `main`. The train's own PR into `main` merges
  when the release is ready.
- **Into `main`, only repo infra** that GitHub reads from the default branch:
  CODEOWNERS, the PR and issue templates, Dependabot, these community files and
  the CI workflows.
- Each PR gets a review, and CI on macOS, Windows and Linux, before it merges.
  The CI workflow lands with the app's scaffold.

## Development setup

This comes with the code. The app is planned as a Tauri 2 shell (Rust) with a
React and TypeScript front end; the setup steps and the checks CI runs will be
listed here when they land.

## Conventions

- A change that makes rlxapp keep something new on disk, change another
  program's settings, or reach the network updates SECURITY.md's "What rlxapp
  stores, changes and sends" in the same PR.

## Reporting bugs / proposing features

A security problem goes privately, as SECURITY.md says, never in an issue.
Questions, and ideas that are not yet a feature, go to Discussions.

For a bug, open an issue describing what you expected and what happened. For larger
changes, it's worth opening an issue to discuss the approach before writing
code.
