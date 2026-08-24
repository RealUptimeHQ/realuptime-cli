# realuptime CLI

A zero-dependency command-line client for the [RealUptime](https://realuptime.io)
REST API and the public outage endpoint. Node 22 or newer; nothing else.

Full reference: https://realuptime.io/docs/cli

## Install

Homebrew (macOS and Linux):

```bash
brew install realuptimehq/realuptime/realuptime
```

npm, from the signed release tarball on GitHub:

```bash
npm install -g https://github.com/RealUptimeHQ/realuptime-cli/releases/download/cli-0.2.0/realuptime-cli-0.2.0.tgz
```

npm, from the registry. Not published yet: this command will work the day
`@realuptime/cli` lands on npm, and until then the two paths above are the
real installs:

```bash
npm install -g @realuptime/cli
```

Every release ships `SHA256SUMS` and `SHA256SUMS.sig` next to the tarball.
The signature is a cosign signature over `SHA256SUMS` by the key whose public
half is served at https://realuptime.io/.well-known/cosign.pub:

```bash
curl -fsSLO https://realuptime.io/.well-known/cosign.pub
cosign verify-blob --key cosign.pub --signature SHA256SUMS.sig SHA256SUMS
sha256sum -c SHA256SUMS
```

## Use

```bash
export REALUPTIME_API_KEY=ru_live_...

realuptime checks list
realuptime checks create --name API --url https://api.example.com/health
realuptime checks delete <id>

realuptime incidents list --limit 20
realuptime incidents create --status-page-id <id> --check-id <id> --region iad --title "API is down" --body "Investigating."
realuptime incidents update <id> --status resolved --body "Fixed." [--force]

realuptime status-pages list

# Keyless: no API key needed, reads the public /outages/:slug JSON endpoint.
realuptime outages github --region iad

realuptime errors issues list --project-id <id> --status open
realuptime errors releases announce --project-id <id> --release v2.4.1 --commit-sha a1b2c3d --repo-url https://github.com/acme/widgets

# --json on any command prints the untouched API response.
realuptime checks list --json
realuptime --version
```

`--api-key` / `REALUPTIME_API_KEY` and `--api-url` / `REALUPTIME_API_URL`
(default `https://realuptime.io/api/v1`) configure every command except
`outages`, which never sends a key. A refusal prints the API's own error
message, its `RU-XXXX` code, and the KB link exactly as the API returned
them, then exits non-zero.

The REST API (every command except `outages`) is a Growth and Scale feature;
see https://realuptime.io/docs/api for keys, scopes, and rate limits.

## Monitoring as code (REA-246)

Declare http checks in `realuptime.yaml` / `.json` using the REST API's own
`POST /checks` field names, then reconcile the account to it. Guide:
https://docs.realuptime.io/monitoring-as-code. Example: `examples/realuptime.yaml`.

```bash
realuptime export -f realuptime.yaml                 # bootstrap from the account
realuptime validate -f realuptime.yaml               # offline parse + validate
realuptime apply -f realuptime.yaml --dry-run        # plan; exit 2 if changes pending
realuptime apply -f realuptime.yaml                  # create / update
realuptime apply -f realuptime.yaml --prune --yes    # also delete http checks not in the file
realuptime apply -f realuptime.yaml --allow-replace  # accept delete+recreate for url/intervalSeconds
```

Exit codes: 0 ok / nothing to do, 1 error, 2 dry-run drift. `name` is the
match key. Regions and assertions update in place; url/intervalSeconds
changes are a `replace` (refused without `--allow-replace`). Non-http checks
are never touched. v1 declares `checks` only: the API has no write surface
for status pages, components, channels, or alert rules yet.

Layout: `cli.ts` (entry), `commands/`, `mac/` (definition parser/validator,
strict YAML subset, plan/diff, apply, export). Tests: `vitest run`;
`mac/definition-drift.test.ts` pins the validator to `packages/db/api-schemas.ts`.

## License

MIT. See [LICENSE](./LICENSE).

---

# @realuptime/cli (workspace package)

`realuptime`: a zero-dependency Node 22 command-line client for the
RealUptime REST API and the public outage endpoint (REA-180). The full
command list is in `docs/api.md`, "CLI", and in `realuptime help`.

## Install

There is no public install path yet. The package is `private: true` in a
private monorepo, and it is not on npm; publishing waits on an npm token
(REA-223) and the mirror/publish flow the SDKs already have (REA-209). Until
then the two ways to run it are:

```bash
# Inside this repository (no install step: the CLI has zero dependencies
# and runs on Node 22's built-in type stripping):
node --experimental-strip-types packages/cli/bin/realuptime.ts help

# Or through pnpm, from the repo root:
pnpm --filter @realuptime/cli exec realuptime help
```

Note that `npm install github:RealUptimeHQ/realuptime-errors-js` installs
the **errors SDK mirror** (public, works today), which carries the Vite and
webpack source-map plugins below, not this CLI.

## Configuration

- `--api-key` or `REALUPTIME_API_KEY`, `--api-url` or `REALUPTIME_API_URL`
  (default `https://realuptime.io/api/v1`), for every command except the two
  below.
- `outages <slug>` is keyless.
- `errors sourcemaps upload` is authenticated by the project's **ingest**
  key, not the account API key: `--dsn` / `REALUPTIME_ERRORS_DSN`, or
  `--ingest-key` / `REALUPTIME_ERRORS_INGEST_KEY` (origin taken from
  `--api-url`).
- `--json` prints the untouched API response (or, for the upload, the
  summary object). A refusal prints the API's own message, its `RU-XXXX`
  code and KB link, and exits 1.

## `errors sourcemaps upload` (REA-254)

```bash
export REALUPTIME_ERRORS_DSN=https://realuptime.io/api/errors/v1/ingest/rue_...

realuptime errors sourcemaps upload dist --release v2.4.1
realuptime errors sourcemaps upload dist/assets/app.js.map dist/assets/vendor.js.map --release v2.4.1
realuptime errors sourcemaps upload .next/static --release "$GITHUB_SHA" --url-prefix ~/_next/static
realuptime errors sourcemaps upload dist --release v2.4.1 --dry-run
```

- A directory is walked recursively for `.map` files (`node_modules` and
  `.git` skipped); each map is named by its path relative to that
  directory. An explicit file is named by its basename. `--url-prefix`
  prepends a path when the bundle is served from somewhere other than the
  directory layout (matching is by path suffix, so it is rarely needed).
- `--release` must be the same string the app passes to `init({ release })`;
  maps are chosen per event by that exact value.
- Progress goes to stderr one batch at a time (batches of 10, the server's
  per-request cap); each file's sha256 is printed so two runs over the
  same build are visibly the same upload. Re-uploading replaces same-named
  maps for the release and the summary reports `stored` / `replaced` as the
  server answered.
- Refusals are whole and local where they can be: no `.map` files, a file
  over 2MB, more than 50 maps for one release, or a missing path exit 1
  before any request. A server refusal mid-way says which batches already
  landed.
- `--dry-run` collects and pre-flights, prints the file list with hashes,
  and sends nothing.

The same upload logic is the SDK's Vite and webpack plugins
(`packages/errors-js/sourcemaps.ts`, `vite.ts`, `webpack.ts`; importable as
`@realuptime/errors/vite` and `@realuptime/errors/webpack` from the public
SDK mirror). The CLI imports that core by relative path so the logic exists
once and the CLI stays dependency-free; a future publish step bundles it.

Without the CLI, the endpoint takes one JSON call:

```bash
curl -X POST "https://realuptime.io/api/errors/v1/sourcemaps/rue_..." \
  -H 'content-type: application/json' \
  -d '{"release":"v2.4.1","files":[{"name":"assets/app.js.map","content":"<the map JSON, as a string>"}]}'
```

## Tests

```bash
pnpm --filter @realuptime/cli test      # vitest, stub transport, no network
pnpm --filter @realuptime/cli typecheck
```
