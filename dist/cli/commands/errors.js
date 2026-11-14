import { flagBoolean, flagNumber, flagString, requireFlagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
// The upload core is the SDK's (cli/sourcemaps.ts is a copy of it).
import { apiKeyAllowedFor, collectSourcemapFiles, formatProgressLine, preflightSourcemapFiles, resolveSourcemapUploadUrl, SourcemapUploadError, uploadSourcemaps, } from "../sourcemaps.js";
/** `POST /errors/projects`: creates an Errors project and returns its ingest
 * addresses (`dsn`, `sentryDsn`) in the same response -- the only time they
 * are ever returned (docs/api.md "POST /errors/projects"). The plan's project
 * allowance applies exactly as it does in the dashboard. */
export function errorsProjectsCreate(client, flags) {
    return apiRequest(client, {
        method: "POST",
        path: "/errors/projects",
        body: { name: requireFlagString(flags, "name") },
    });
}
/** `GET /errors/projects/:id/issues` -- the RealUptime Errors read surface
 * (docs/api.md "Errors"), gated on the account holding the Errors product,
 * same as every other errors route. */
export function errorsIssuesList(client, flags) {
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
export function errorsProjectsList(client) {
    return apiRequest(client, { path: "/errors/projects" });
}
/** `POST /errors/releases` (REA-185): announce a release's commit/deploy
 * metadata from CI or a deploy script (docs/api.md "POST /errors/releases").
 * Idempotent on (project-id, release) -- a re-run with the same two values
 * updates the same release rather than creating a second one. */
export function errorsReleasesAnnounce(client, flags) {
    const body = {
        projectId: requireFlagString(flags, "project-id"),
        release: requireFlagString(flags, "release"),
    };
    const commitSha = flagString(flags, "commit-sha");
    if (commitSha !== undefined)
        body.commitSha = commitSha;
    const repoUrl = flagString(flags, "repo-url");
    if (repoUrl !== undefined)
        body.repoUrl = repoUrl;
    const deployedAt = flagString(flags, "deployed-at");
    if (deployedAt !== undefined)
        body.deployedAt = deployedAt;
    const previousRelease = flagString(flags, "previous-release");
    if (previousRelease !== undefined)
        body.previousRelease = previousRelease;
    return apiRequest(client, { method: "POST", path: "/errors/releases", body });
}
/** The status each `errors issues <verb>` moves an issue to. `reopen` is
 * `open`: the API has no "unresolved". */
const ISSUE_VERB_STATUS = { resolve: "resolved", ignore: "ignored", reopen: "open" };
/** `PATCH /errors/issues/:id`: `errors issues resolve|ignore|reopen <id>`.
 * Sending the status an issue already has succeeds, so a CI step can run it
 * again. Needs a read-write key (docs/api.md "PATCH /errors/issues/:id"). */
export function errorsIssuesSetStatus(client, verb, id) {
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
 * plugins call). The project is named by its DSN (`--dsn` /
 * `REALUPTIME_ERRORS_DSN`) or a bare ingest key (`--ingest-key` /
 * `REALUPTIME_ERRORS_INGEST_KEY`, with the origin taken from `--api-url`);
 * the upload is authorised by the account API key (`--api-key` /
 * `REALUPTIME_API_KEY`), which needs Errors write access (REA-1264). An
 * upload without one is accepted until February 17, 2027 with a warning,
 * which is printed.
 *
 * Progress goes to stderr one batch at a time; the result (stdout) is the
 * summary object, rendered as JSON under --json. Refusals are local and
 * whole (a file over the cap, no maps found, a server 4xx) -- see the core's
 * own doc comment. `--dry-run` collects and pre-flights but sends nothing.
 */
export async function errorsSourcemapsUpload(client, positionals, flags, env, stderr) {
    const release = requireFlagString(flags, "release");
    if (positionals.length === 0) {
        throw new CliError("Pass at least one directory or .map file to upload, e.g. realuptime errors sourcemaps upload dist --release v2.4.1");
    }
    const dsn = flagString(flags, "dsn") ?? env.REALUPTIME_ERRORS_DSN;
    const ingestKey = flagString(flags, "ingest-key") ?? env.REALUPTIME_ERRORS_INGEST_KEY;
    let url;
    try {
        url = resolveSourcemapUploadUrl({ dsn, ingestKey, origin: new URL(client.apiUrl).origin });
    }
    catch (cause) {
        throw new CliError(cause instanceof Error ? cause.message : String(cause));
    }
    const urlPrefix = flagString(flags, "url-prefix");
    const { files, duplicates, missing } = collectSourcemapFiles(positionals, { urlPrefix });
    if (missing.length > 0)
        throw new CliError(`Not found: ${missing.join(", ")}. Nothing was uploaded.`);
    const problem = preflightSourcemapFiles(files);
    if (problem)
        throw new CliError(problem);
    for (const name of duplicates)
        stderr(`duplicate artifact name ${name}; the first occurrence was kept`);
    if (client.apiKey && !apiKeyAllowedFor(url, new URL(client.apiUrl).origin)) {
        stderr(`the API key is sent only to realuptime.io over https or the --api-url origin; not to ${new URL(url).origin}`);
    }
    if (flagBoolean(flags, "dry-run")) {
        stderr(`dry run: ${files.length} source map${files.length === 1 ? "" : "s"} would be uploaded for release ${release} to ${url.replace(/rue_[0-9a-f]+$/, "rue_...")}`);
        return {
            dryRun: true,
            release,
            files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
        };
    }
    try {
        const summary = await uploadSourcemaps({
            url,
            release,
            files,
            apiKey: client.apiKey,
            trustedOrigin: new URL(client.apiUrl).origin,
            fetchImpl: client.fetchImpl,
            onProgress: (progress) => stderr(formatProgressLine(progress)),
        });
        if (summary.removedReleases.length > 0) {
            stderr(`to stay within the project's source-map storage, maps were removed for: ${summary.removedReleases.join(", ")}`);
        }
        if (summary.warning)
            stderr(`warning: ${summary.warning}`);
        return summary;
    }
    catch (cause) {
        if (cause instanceof SourcemapUploadError) {
            throw new CliError(cause.message, { code: cause.code, httpStatus: cause.httpStatus });
        }
        throw cause;
    }
}
