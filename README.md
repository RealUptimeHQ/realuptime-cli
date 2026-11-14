# realuptime CLI

A zero-dependency command-line client for the [RealUptime](https://realuptime.io)
REST API and the public outage endpoint. Node 22 or newer; nothing else.

Full reference: https://docs.realuptime.io/cli

## Install

Homebrew (macOS and Linux):

```bash
brew install realuptimehq/realuptime/realuptime
```

npm:

```bash
npm install -g @realuptime/cli
```

npm, from the signed release tarball on GitHub:

<!-- x-release-please-start-version -->
```bash
version=0.4.0
npm install -g "https://github.com/RealUptimeHQ/realuptime-cli/releases/download/cli-$version/realuptime-cli-$version.tgz"
```
<!-- x-release-please-end -->

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
realuptime checks runs <id> [--limit 20]   # a heartbeat monitor's runs: start, finish, outcome, duration

realuptime incidents list --limit 20
realuptime incidents create --status-page-id <id> --check-id <id> --region iad --title "API is down" --body "Investigating."
realuptime incidents update <id> --status resolved --body "Fixed." [--force]

realuptime status-pages list
realuptime status-pages create --name "Acme status" [--slug acme]
realuptime status-pages get <id>                     # public_url is the page's address

realuptime components list --status-page-id <id>
realuptime components add --status-page-id <id> --check-id <id> [--name "API"]

realuptime channels list                             # the account owner's email, Slack, and registered channels
realuptime channels create --type email              # email alerts go to the account owner's address
realuptime channels create --type slack              # webhook read from REALUPTIME_ALERT_WEBHOOK_URL
realuptime channels create --type discord --name Ops --webhook-url <url>
realuptime channels test <id>                        # sends one real test alert; exit 1 if it is refused

realuptime heartbeats list
realuptime heartbeats create --name "nightly backup" --interval 86400 --grace 3600

realuptime agent token create --name web-1           # registers a server agent

realuptime terraform export                          # writes ./realuptime-tf/*.tf + import.sh
realuptime terraform export --dir infra/tf --force    # a different directory, overwriting what's there

# Keyless: no API key needed, reads the public /outages/:slug JSON endpoint.
realuptime outages github --region iad

realuptime errors projects list
realuptime errors projects create --name web
realuptime errors issues list --project-id <id> --status open
realuptime errors issues resolve <id>   # also: ignore <id>, reopen <id>; needs a read-write key
realuptime errors releases announce --project-id <id> --release v2.4.1 --commit-sha a1b2c3d --repo-url https://github.com/acme/widgets
realuptime errors sourcemaps upload dist --release v2.4.1

# --json on any command prints the untouched API response.
realuptime checks list --json
realuptime --version
```

`--api-key` / `REALUPTIME_API_KEY` and `--api-url` / `REALUPTIME_API_URL`
(default `https://realuptime.io/api/v1`) configure every command except
`outages`, which never sends a key. A refusal prints the API's own error
message, its `RU-XXXX` code, and the KB link exactly as the API returned
them, then exits non-zero.

The REST API (every command except `outages`) is available on every plan;
see https://docs.realuptime.io/api for keys, scopes, and rate limits.

## Values shown once

Three commands return a value that RealUptime stores only as a digest, so it
is printed by the command that created it and can never be read again:

| Command | Value | Field |
| --- | --- | --- |
| `errors projects create` | the project's ingest address | `dsn` |
| `heartbeats create` | the monitor's ping URL | `pingUrl` |
| `agent token create` | the server agent's token | `token` |

The value goes to stdout only. `--field <path>` prints one value of the
response and nothing else, so it can be captured without reaching a terminal
or a log:

```bash
REALUPTIME_ERRORS_DSN="$(realuptime errors projects create --name web --field dsn)"
REALUPTIME_AGENT_TOKEN="$(realuptime agent token create --name web-1 --field token)"
```

A refusal leaves stdout empty and exits non-zero, so the variable is empty
rather than holding an error message. `--field` takes a dotted path into any
response, for example `--field statusPage.public_url` or `--field check.id`.

## Alert channels

`channels create --type email` creates nothing: email alerts go to the
account owner's address, and the command answers with that destination once
the address is confirmed. `--type slack` sets the account's one Slack incoming
webhook and never replaces a different one that is already set. Every other
type registers a channel under `--name`.

A channel's destination is a credential, so it can come from the environment
instead of the command line: `--webhook-url` falls back to
`REALUPTIME_ALERT_WEBHOOK_URL`, and `--channel-api-key` (opsgenie, incidentio)
to `REALUPTIME_CHANNEL_API_KEY`.

## Monitoring as code

Declare http checks in `realuptime.yaml` or `realuptime.json` using the REST
API's own `POST /checks` field names, then reconcile the account to the file.
Guide: https://docs.realuptime.io/monitoring-as-code

```bash
realuptime export -f realuptime.yaml                 # bootstrap from the account
realuptime validate -f realuptime.yaml               # offline parse + validate
realuptime apply -f realuptime.yaml --dry-run        # plan; exit 2 if changes pending
realuptime apply -f realuptime.yaml                  # create / update
realuptime apply -f realuptime.yaml --prune --yes    # also delete http checks not in the file
realuptime apply -f realuptime.yaml --allow-replace  # accept delete+recreate for url/intervalSeconds
```

Exit codes: 0 ok or nothing to do, 1 error, 2 dry-run drift. `name` is the
match key. Regions and assertions update in place; a change to `url` or
`intervalSeconds` is a `replace`, refused without `--allow-replace`. Non-http
checks are never touched. A definition file declares `checks` only: status
pages, components and channels are created with the commands above.

## Terraform export

`realuptime terraform export` reads the account's checks, status pages,
components and notification channels and writes `.tf` files for the
`realuptime` Terraform provider, plus an `import.sh` with one
`terraform import` command per resource. Guide:
https://docs.realuptime.io/terraform

```bash
realuptime terraform export                          # -> ./realuptime-tf/
realuptime terraform export --dir infra/tf --force    # a different directory; --force allows overwriting a non-empty one
```

No exported file contains a credential: the API never returns a channel's
webhook URL or API key, so `terraform.tfvars.example` carries one placeholder
per channel credential to fill in.

## Source maps

`errors sourcemaps upload` names the project by its DSN (`--dsn` /
`REALUPTIME_ERRORS_DSN`, or `--ingest-key` / `REALUPTIME_ERRORS_INGEST_KEY`
with the origin taken from `--api-url`) and is authorised by the account API
key (`--api-key` / `REALUPTIME_API_KEY`), which needs Errors write access.
Keep the key in CI secrets: the DSN ships in your app and only sends events.
Until February 17, 2027 an upload without the key still works and the server's
warning is printed; after that it is refused. A DSN on
`ingest.realuptime.io`, which is what every project created since the hostname
split has, uploads to `https://realuptime.io`: source maps are stored there, not
on the ingest host. A DSN on any other host (a self-hosted or local one) uploads
to its own.

```bash
realuptime errors sourcemaps upload dist --release v2.4.1
realuptime errors sourcemaps upload .next/static --release "$GITHUB_SHA" --url-prefix ~/_next/static
realuptime errors sourcemaps upload dist --release v2.4.1 --dry-run
```

`--release` must be the string the application passes to `init({ release })`.
A directory is walked for `.map` files; a file over 2MB, more than 50 maps for
one release, or a missing path exits 1 before any request.

## Running the tests

The suite sits beside the code as `*.test.ts` files and needs Node.js 22 or
newer. In a checkout, `npm install` and then `npm test` run it; in the source
workspace, `pnpm test` does. A change to the CLI is expected to come with a test for it.

## License

MIT. See [LICENSE](./LICENSE).
