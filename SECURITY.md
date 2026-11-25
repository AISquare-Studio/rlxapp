# Security policy

## Supported versions

rlxapp has no release yet. Once it does, only the latest release gets security
fixes, so please check your version against the
[latest release](https://github.com/AISquare-Studio/rlxapp/releases) before you
report.

rlxapp runs [rlx](https://github.com/AISquare-Studio/rlx), which has its own
[security policy](https://github.com/AISquare-Studio/rlx/security/policy). If
the problem is in rlx itself, report it there.

## Reporting a vulnerability

**Please do not report a security problem in a public issue, pull request or
discussion.**

Report it privately, either way:

- **GitHub:** on the [Security tab](https://github.com/AISquare-Studio/rlxapp/security),
  choose *Report a vulnerability*. This is GitHub's private vulnerability
  reporting: only you and the maintainers see the report.
- **Email:** anmol@aisquare.studio.

Include the rlxapp version, the rlx version (`rlx --version`), your OS, how you
installed it, and the steps to reproduce. We aim to acknowledge a report within
3 business days.

## What rlxapp stores, changes and sends

The code is coming soon, and this inventory comes with it. Until then:

- Everything rlx keeps on disk, changes in Claude Code's settings and sends is
  listed in rlx's
  [SECURITY.md](https://github.com/AISquare-Studio/rlx/blob/main/SECURITY.md).
  What rlx does on rlxapp's behalf is covered there.
- Each change that makes rlxapp itself keep something on disk, change another
  program's settings, or reach the network adds it here, in the same PR.
