import type { ParsedArgs } from "../args.ts";
import { flagBoolean, flagNumber, flagString, requireFlagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";
// The upload core is the SDK's (cli/sourcemaps.ts is a copy of it).
import {
  collectSourcemapFiles,
  formatProgressLine,
  preflightSourcemapFiles,
  resolveSourcemapUploadUrl,
  SourcemapUploadError,
  uploadSourcemaps,
} from "../sourcemaps.ts";

/** `POST /errors/projects`: creates an Errors project and returns its ingest
 * addresses (`dsn`, `sentryDsn`) in the same response -- the only time they
 * are ever returned (docs/api.md "POST /errors/projects"). The plan's project
 * allowance applies exactly as it does in the dashboard. */
export function errorsProjectsCreate(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  return apiRequest(client, {
    method: "POST",
    path: "/errors/projects",
    body: { name: requireFlagString(flags, "name") },
  });
}

/** `GET /errors/projects/:id/issues` -- the RealUptime Errors read surface
 * (docs/api.md "Errors"), gated on the account holding the Errors product,
 * same as every other errors route. */
export function errorsIssuesList(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const projectId = requireFlagString(flags, "project-id");
  return apiRequest(client, {
    path: `/errors/projects/${encodeURIComponent(projectId)}/issues`,
    query: {
      q: flagString(flags, "q"),
      release: flagString(flags, "release"),
      status: flagString(flags, "status"),
      window: flagString(flags, "window"),
      limit: flagNumber(flags, "limit"),
    },
  });
}

/** `GET /errors/projects`: the account's projects, quota and usage. Never an
 * ingest address: it is shown once, at creation. */
export function errorsProjectsList(client: ClientConfig): Promise<unknown> {
  return apiRequest(client, { path: "/errors/projects" });
}

/** `POST /errors/releases` (REA-185): announce a release's commit/deploy
 * metadata from CI or a deploy script (docs/api.md "POST /errors/releases").
 * Idempotent on (project-id, release) -- a re-run with the same two values
 * updates the same release rather than creating a second one. */
export function errorsReleasesAnnounce(client: ClientConfig, flags: ParsedArgs["flags"]): Promise<unknown> {
  const body: Record<string, unknown> = {
    projectId: requireFlagString(flags, "project-id"),
    release: requireFlagString(flags, "release"),
  };
  const commitSha = flagString(flags, "commit-sha");
  if (commitSha !== undefined) body.commitSha = commitSha;
  const repoUrl = flagString(flags, "repo-url");
  if (repoUrl !== undefined) body.repoUrl = repoUrl;
  const deployedAt = flagString(flags, "deployed-at");
  if (deployedAt !== undefined) body.deployedAt = deployedAt;
  const previousRelease = flagString(flags, "previous-release");
  if (previousRelease !== undefined) body.previousRelease = previousRelease;
  return apiRequest(client, { method: "POST", path: "/errors/releases", body });
}

/** The status each `errors issues <verb>` moves an issue to. `reopen` is
 * `open`: the API has no "unresolved". */
const ISSUE_VERB_STATUS = { resolve: "resolved", ignore: "ignored", reopen: "open" } as const;
export type ErrorsIssueVerb = keyof typeof ISSUE_VERB_STATUS;

/** `PATCH /errors/issues/:id`: `errors issues resolve|ignore|reopen <id>`.
 * Sending the status an issue already has succeeds, so a CI step can run it
 * again. Needs a read-write key (docs/api.md "PATCH /errors/issues/:id"). */
export function errorsIssuesSetStatus(
  client: ClientConfig,
  verb: ErrorsIssueVerb,
  id: string | undefined,
): Promise<unknown> {
  if (!id) {
    throw new CliError(`Usage: realuptime errors issues ${verb} <id>`);
  }
  return apiRequest(client, {
    method: "PATCH",
    path: `/errors/issues/${encodeURIComponent(id)}`,
    body: { status: ISSUE_VERB_STATUS[verb] },
  });
}

/**
 * `realuptime errors sourcemaps upload <dir-or-files...> --release <v>` (REA-254):
 * wraps `POST /api/errors/v1/sourcemaps/<key>` through the shared upload core
 * in packages/errors-js/sourcemaps.ts (the same code the Vite and webpack
 * plugins call). This is the one command that does NOT use the account API
 * key: the endpoint is ingest-key authenticated, so the credential is the
 * project DSN (`--dsn` / `REALUPTIME_ERRORS_DSN`) or a bare ingest key
 * (`--ingest-key` / `REALUPTIME_ERRORS_INGEST_KEY`, with the origin taken
 * from `--api-url`).
 *
 * Progress goes to stderr one batch at a time; the result (stdout) is the
 * summary object, rendered as JSON under --json. Refusals are local and
 * whole (a file over the cap, no maps found, a server 4xx) -- see the core's
 * own doc comment. `--dry-run` collects and pre-flights but sends nothing.
 */
export async function errorsSourcemapsUpload(
  client: ClientConfig,
  positionals: string[],
  flags: ParsedArgs["flags"],
  env: Record<string, string | undefined>,
  stderr: (line: string) => void,
): Promise<unknown> {
  const release = requireFlagString(flags, "release");
  if (positionals.length === 0) {
    throw new CliError(
      "Pass at least one directory or .map file to upload, e.g. realuptime errors sourcemaps upload dist --release v2.4.1",
    );
  }
  const dsn = flagString(flags, "dsn") ?? env.REALUPTIME_ERRORS_DSN;
  const ingestKey = flagString(flags, "ingest-key") ?? env.REALUPTIME_ERRORS_INGEST_KEY;
  let url: string;
  try {
    url = resolveSourcemapUploadUrl({ dsn, ingestKey, origin: new URL(client.apiUrl).origin });
  } catch (cause) {
    throw new CliError(cause instanceof Error ? cause.message : String(cause));
  }
  const urlPrefix = flagString(flags, "url-prefix");
  const { files, duplicates, missing } = collectSourcemapFiles(positionals, { urlPrefix });
  if (missing.length > 0) throw new CliError(`Not found: ${missing.join(", ")}. Nothing was uploaded.`);
  const problem = preflightSourcemapFiles(files);
  if (problem) throw new CliError(problem);
  for (const name of duplicates) stderr(`duplicate artifact name ${name}; the first occurrence was kept`);
  if (flagBoolean(flags, "dry-run")) {
    stderr(
      `dry run: ${files.length} source map${files.length === 1 ? "" : "s"} would be uploaded for release ${release} to ${url.replace(/rue_[0-9a-f]+$/, "rue_...")}`,
    );
    return {
      dryRun: true,
      release,
      files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
    };
  }
  try {
    return await uploadSourcemaps({
      url,
      release,
      files,
      fetchImpl: client.fetchImpl,
      onProgress: (progress) => stderr(formatProgressLine(progress)),
    });
  } catch (cause) {
    if (cause instanceof SourcemapUploadError) {
      throw new CliError(cause.message, { code: cause.code, httpStatus: cause.httpStatus });
    }
    throw cause;
  }
}
