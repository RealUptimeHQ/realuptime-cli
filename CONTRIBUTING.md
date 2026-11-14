# Contributing

This repository is a read-only mirror: development happens in RealUptime's
private repository, and each release is exported here from the real source,
tests included. That has two practical consequences:

- **Issues are welcome.** Bug reports and feature requests filed here are
  read and triaged like any other support channel. A good bug report names
  the CLI version (`realuptime --version`), your operating system and Node.js
  version, the command you ran with secrets removed, what you expected and
  what happened.
- **Pull requests cannot be merged directly.** A maintainer will re-apply an
  accepted change in the source repository crediting you, and it will appear
  here in the next mirror publish. Small patches are genuinely easier to
  land than large ones.

Security problems are not reported in public issues; see
[SECURITY.md](SECURITY.md).

## Tests

New functionality and bug fixes are expected to come with a test in the same
change, and no change lands unless the whole suite passes; the suite is the one in this
repository, run by RealUptime's merge gate before anything is published
here. Tests sit beside the code as `*.test.ts` files. If you propose a
patch, include the test that fails without it.

Run the test suite with `npm install && npm test` (Node.js 22 or newer).

## Release notes

Each release is described in [CHANGELOG.md](CHANGELOG.md) and on the
releases page.
