import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";
import type { FetchLike } from "./http.ts";
import { CLI_VERSION } from "./version.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A zero-dependency stub transport: records every call it receives and
 * answers with a fixed JSON body/status, so a test can assert both what the
 * CLI SENT (method, path, query, auth header, body) and how it renders what
 * comes back -- a full command round-trip with no real network. */
function stubFetch(response: { status: number; body: unknown }): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>)) headers[key] = value;
    }
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(response.body === null || response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as FetchLike;
  return { fetchImpl, calls };
}

function harness(response: { status: number; body: unknown }) {
  const { fetchImpl, calls } = stubFetch(response);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const run = (argv: string[], env: Record<string, string | undefined> = { REALUPTIME_API_KEY: "ru_live_test" }) =>
    runCli(argv, {
      fetchImpl,
      env,
      stdout: (line) => stdoutLines.push(line),
      stderr: (line) => stderrLines.push(line),
    });
  return { run, calls, stdoutLines, stderrLines };
}

describe("realuptime checks", () => {
  it("list: GET /checks with the bearer header, --json prints the raw response", async () => {
    const { run, calls, stdoutLines } = harness({ status: 200, body: { checks: [{ id: "c1", name: "API", status: "operational" }] } });
    const code = await run(["checks", "list", "--json"]);
    expect(code).toBe(0);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/checks");
    expect(calls[0].headers.Authorization).toBe("Bearer ru_live_test");
    expect(JSON.parse(stdoutLines[0])).toEqual({ checks: [{ id: "c1", name: "API", status: "operational" }] });
  });

  it("list: human output summarizes one line per check", async () => {
    const { run, calls, stdoutLines } = harness({ status: 200, body: { checks: [{ id: "c1", name: "API", url: "https://x" }] } });
    await run(["checks", "list"]);
    expect(calls).toHaveLength(1);
    expect(stdoutLines[0]).toContain("id=c1");
    expect(stdoutLines[0]).toContain("name=API");
  });

  it("create: POST /checks with name/url/regions in the body", async () => {
    const { run, calls } = harness({ status: 201, body: { check: { id: "c2" } } });
    await run(["checks", "create", "--name", "API", "--url", "https://api.example.com", "--regions", "iad,fra", "--interval", "120"]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/checks");
    expect(calls[0].body).toEqual({ name: "API", url: "https://api.example.com", regions: ["iad", "fra"], intervalSeconds: 120 });
  });

  it("create: missing --name fails locally without ever calling fetch", async () => {
    const { run, calls, stderrLines } = harness({ status: 200, body: {} });
    const code = await run(["checks", "create", "--url", "https://x"]);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("--name is required");
  });

  it("delete: DELETE /checks/:id, renders a confirmation", async () => {
    const { run, calls, stdoutLines } = harness({ status: 204, body: null });
    const code = await run(["checks", "delete", "c3"]);
    expect(code).toBe(0);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/checks/c3");
    expect(stdoutLines[0]).toBe("Deleted c3.");
  });

  it("runs: GET /checks/:id/runs with an optional limit (REA-1052)", async () => {
    const { run, calls, stdoutLines } = harness({ status: 200, body: { runs: [{ id: "r1", outcome: "success" }], visible_since: "x", next_before: null } });
    const code = await run(["checks", "runs", "hb-1", "--limit", "5", "--json"]);
    expect(code).toBe(0);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/checks/hb-1/runs?limit=5");
    expect(JSON.parse(stdoutLines[0]).runs[0].outcome).toBe("success");
  });

  it("runs: without an id prints its usage and exits non-zero", async () => {
    const { run, stderrLines } = harness({ status: 200, body: {} });
    expect(await run(["checks", "runs"])).toBe(1);
    expect(stderrLines[0]).toContain("realuptime checks runs <id>");
  });

  it("surfaces the API's RU- code and KB link on a refusal, and exits non-zero", async () => {
    const { run, stderrLines } = harness({
      status: 403,
      body: { error: "This API key is read-only.", code: "RU-1004", docs: "https://realuptime.io/kb/errors/ru-1004" },
    });
    const code = await run(["checks", "create", "--name", "API", "--url", "https://x"]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("This API key is read-only. [RU-1004]");
    expect(stderrLines[0]).toContain("https://realuptime.io/kb/errors/ru-1004");
  });
});

describe("realuptime incidents", () => {
  it("list: GET /incidents?limit=20", async () => {
    const { run, calls } = harness({ status: 200, body: { incidents: [] } });
    await run(["incidents", "list", "--limit", "20"]);
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/incidents?limit=20");
  });

  it("create: POST /incidents with every required field", async () => {
    const { run, calls } = harness({ status: 201, body: { incident: { id: "i1" } } });
    await run([
      "incidents",
      "create",
      "--status-page-id",
      "sp1",
      "--check-id",
      "c1",
      "--region",
      "iad",
      "--title",
      "API is down",
      "--body",
      "Investigating.",
    ]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({
      statusPageId: "sp1",
      checkId: "c1",
      region: "iad",
      title: "API is down",
      body: "Investigating.",
    });
  });

  it("update: POST /incidents/:id/updates, --force only present when passed", async () => {
    const { run, calls } = harness({ status: 201, body: { update: { id: "u1" } } });
    await run(["incidents", "update", "i1", "--status", "resolved", "--body", "Fixed.", "--force"]);
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/incidents/i1/updates");
    expect(calls[0].body).toEqual({ status: "resolved", body: "Fixed.", force: true });
  });

  it("update: 409 live-outage conflict surfaces RU-5003", async () => {
    const { run, stderrLines } = harness({
      status: 409,
      body: { error: "Our last probe still reports it down.", code: "RU-5003" },
    });
    const code = await run(["incidents", "update", "i1", "--status", "resolved", "--body", "Fixed."]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("RU-5003");
  });
});

describe("realuptime maintenance", () => {
  it("start: POST /maintenance with durationMinutes as a number", async () => {
    const { run, calls } = harness({ status: 201, body: { window: { id: "w1" } } });
    await run([
      "maintenance",
      "start",
      "--status-page-id",
      "sp1",
      "--title",
      "DB maintenance",
      "--body",
      "Applying a patch.",
      "--duration-minutes",
      "30",
    ]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/maintenance");
    expect(calls[0].body).toEqual({
      statusPageId: "sp1",
      title: "DB maintenance",
      body: "Applying a patch.",
      durationMinutes: 30,
    });
  });

  it("start: --ends-at and --component-ids ride the body unchanged", async () => {
    const { run, calls } = harness({ status: 201, body: { window: { id: "w1" } } });
    await run([
      "maintenance",
      "start",
      "--status-page-id",
      "sp1",
      "--title",
      "DB maintenance",
      "--body",
      "Applying a patch.",
      "--ends-at",
      "2026-09-02T04:00:00Z",
      "--component-ids",
      "c1,c2",
    ]);
    expect(calls[0].body).toEqual({
      statusPageId: "sp1",
      title: "DB maintenance",
      body: "Applying a patch.",
      endsAt: "2026-09-02T04:00:00Z",
      componentIds: ["c1", "c2"],
    });
  });

  it("end: DELETE /maintenance/:id", async () => {
    const { run, calls } = harness({ status: 200, body: { window: { id: "w1" } } });
    await run(["maintenance", "end", "w1"]);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/maintenance/w1");
  });

  it("end: missing id fails locally without ever calling fetch", async () => {
    const { run, calls, stderrLines } = harness({ status: 200, body: {} });
    const code = await run(["maintenance", "end"]);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("Usage: realuptime maintenance end");
  });

  it("status: GET /maintenance?statusPageId=...", async () => {
    const { run, calls } = harness({ status: 200, body: { window: null } });
    await run(["maintenance", "status", "--status-page-id", "sp1"]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/maintenance?statusPageId=sp1");
  });
});

describe("realuptime status-pages", () => {
  it("list: GET /status-pages", async () => {
    const { run, calls } = harness({ status: 200, body: { statusPages: [{ id: "sp1", slug: "acme" }] } });
    await run(["status-pages", "list"]);
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/status-pages");
    expect(calls[0].method).toBe("GET");
  });
});

describe("realuptime outages", () => {
  it("is keyless: no Authorization header, works with no REALUPTIME_API_KEY set", async () => {
    const { run, calls, stdoutLines } = harness({ status: 200, body: { schema_version: 1, verdict: "up" } });
    const code = await run(["outages", "github", "--region", "iad", "--json"], {});
    expect(code).toBe(0);
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/outages/github?region=iad");
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.parse(stdoutLines[0])).toEqual({ schema_version: 1, verdict: "up" });
  });

  it("missing slug fails locally with a usage message", async () => {
    const { run, calls, stderrLines } = harness({ status: 200, body: {} });
    const code = await run(["outages"], {});
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("Usage: realuptime outages <slug>");
  });
});

describe("realuptime errors projects create", () => {
  const CREATED = {
    project: { id: "p1", name: "My app", keyHint: "abcd", revoked: false },
    dsn: "https://ingest.realuptime.io/api/errors/v1/ingest/rue_abcd",
    sentryDsn: "https://rue_abcd@ingest.realuptime.io/rue_abcd",
  };

  it("POST /errors/projects with the name, and prints the response with both addresses", async () => {
    const { run, calls, stdoutLines } = harness({ status: 201, body: CREATED });
    const code = await run(["errors", "projects", "create", "--name", "My app", "--json"]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/errors/projects");
    expect(calls[0].headers.Authorization).toBe("Bearer ru_live_test");
    expect(calls[0].body).toEqual({ name: "My app" });
    expect(JSON.parse(stdoutLines[0])).toEqual(CREATED);
  });

  it("shows the DSN in the human output too, since it cannot be shown again", async () => {
    const { run, stdoutLines } = harness({ status: 201, body: CREATED });
    await run(["errors", "projects", "create", "--name", "My app"]);
    expect(stdoutLines[0]).toContain(CREATED.dsn);
    expect(stdoutLines[0]).toContain(CREATED.sentryDsn);
  });

  it("refuses locally, without calling the API, when --name is missing", async () => {
    const { run, calls, stderrLines } = harness({ status: 201, body: CREATED });
    const code = await run(["errors", "projects", "create"]);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("--name");
  });

  it("surfaces the plan's project cap with its RU-2008 code and KB link", async () => {
    const { run, stderrLines } = harness({
      status: 403,
      body: {
        error: "Free plans include up to 2 projects. Upgrade for more.",
        code: "RU-2008",
        docs: "https://realuptime.io/kb/errors/ru-2008",
      },
    });
    const code = await run(["errors", "projects", "create", "--name", "Third"]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("Free plans include up to 2 projects.");
    expect(stderrLines[0]).toContain("RU-2008");
    expect(stderrLines[0]).toContain("https://realuptime.io/kb/errors/ru-2008");
  });

  it("names the subcommand in the usage text and in the unknown-subcommand hint", async () => {
    const { run, stdoutLines, stderrLines } = harness({ status: 200, body: {} });
    await run(["help"]);
    expect(stdoutLines[0]).toContain("realuptime errors projects create --name <name>");
    const code = await run(["errors", "projects", "delete"]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("Try: projects list, projects create,");
  });
});

describe("realuptime errors issues list", () => {
  it("GET /errors/projects/:id/issues with every filter as a query param", async () => {
    const { run, calls } = harness({ status: 200, body: { issues: [] } });
    await run(["errors", "issues", "list", "--project-id", "p1", "--status", "open", "--limit", "10"]);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/errors/projects/p1/issues");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("403 without the Errors product surfaces RU-4005", async () => {
    const { run, stderrLines } = harness({ status: 403, body: { error: "This account does not have RealUptime Errors.", code: "RU-4005" } });
    const code = await run(["errors", "issues", "list", "--project-id", "p1"]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("RU-4005");
  });
});

describe("realuptime errors issues resolve | ignore | reopen", () => {
  const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
  const detail = (status: string) => ({
    issue: { id: ISSUE_ID, title: "TypeError: boom", status, resolved_in_release: status === "resolved" ? "v2.4.1" : null },
    releases: [{ release: "v2.4.1" }],
    occurrences: [{ id: 7, message: "boom" }],
    retentionDays: 14,
  });

  it.each([
    ["resolve", "resolved"],
    ["ignore", "ignored"],
    ["reopen", "open"],
  ])("%s: PATCH /errors/issues/:id with status %s, and --json prints the untouched response", async (verb, status) => {
    const body = detail(status);
    const { run, calls, stdoutLines } = harness({ status: 200, body });
    const code = await run(["errors", "issues", verb, ISSUE_ID, "--json"]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(`https://realuptime.io/api/v1/errors/issues/${ISSUE_ID}`);
    expect(calls[0].headers.Authorization).toBe("Bearer ru_live_test");
    expect(calls[0].body).toEqual({ status });
    expect(JSON.parse(stdoutLines[0])).toEqual(body);
  });

  it("prints the updated issue on one line, not the occurrences that ride along", async () => {
    const { run, stdoutLines } = harness({ status: 200, body: detail("resolved") });
    await run(["errors", "issues", "resolve", ISSUE_ID]);
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toBe(`id=${ISSUE_ID} title=TypeError: boom status=resolved`);
  });

  it("refuses locally, without calling the API, when the id is missing", async () => {
    const { run, calls, stderrLines } = harness({ status: 200, body: detail("resolved") });
    const code = await run(["errors", "issues", "resolve"]);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toBe("Usage: realuptime errors issues resolve <id>");
  });

  it("escapes the id in the path", async () => {
    const { run, calls } = harness({ status: 200, body: detail("open") });
    await run(["errors", "issues", "reopen", "a/b c"]);
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/errors/issues/a%2Fb%20c");
  });

  it("surfaces a read-only key's RU-1004 with its KB link, and a missing issue's RU-4006", async () => {
    const readOnly = harness({
      status: 403,
      body: { error: "This API key is read-only. Generate a read-write key to perform this action.", code: "RU-1004", docs: "https://realuptime.io/kb/errors/ru-1004" },
    });
    expect(await readOnly.run(["errors", "issues", "resolve", ISSUE_ID])).toBe(1);
    expect(readOnly.stderrLines[0]).toContain("RU-1004");
    expect(readOnly.stderrLines[0]).toContain("https://realuptime.io/kb/errors/ru-1004");

    const missing = harness({ status: 404, body: { error: "Issue not found.", code: "RU-4006" } });
    expect(await missing.run(["errors", "issues", "ignore", ISSUE_ID])).toBe(1);
    expect(missing.stderrLines[0]).toContain("Issue not found. [RU-4006]");
  });

  it("is in the usage text and the unknown-subcommand hint", async () => {
    const { run, stdoutLines, stderrLines } = harness({ status: 200, body: {} });
    await run(["help"]);
    expect(stdoutLines[0]).toContain("realuptime errors issues resolve <id>");
    expect(stdoutLines[0]).toContain("ignore <id>");
    expect(stdoutLines[0]).toContain("reopen <id>");
    expect(await run(["errors", "issues", "close", ISSUE_ID])).toBe(1);
    expect(stderrLines[0]).toContain("issues resolve, issues ignore, issues reopen");
  });
});

describe("realuptime errors releases announce", () => {
  it("POST /errors/releases with only the required fields", async () => {
    const { run, calls } = harness({ status: 201, body: { release: { id: "r1" }, created: true } });
    await run(["errors", "releases", "announce", "--project-id", "p1", "--release", "v2.4.1"]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://realuptime.io/api/v1/errors/releases");
    expect(calls[0].body).toEqual({ projectId: "p1", release: "v2.4.1" });
  });

  it("passes commit-sha, repo-url, deployed-at, and previous-release when given", async () => {
    const { run, calls } = harness({ status: 200, body: { release: { id: "r1" }, created: false } });
    await run([
      "errors",
      "releases",
      "announce",
      "--project-id",
      "p1",
      "--release",
      "v2.4.1",
      "--commit-sha",
      "abc1234",
      "--repo-url",
      "https://github.com/acme/widgets",
      "--deployed-at",
      "2026-08-22T00:00:00Z",
      "--previous-release",
      "v2.4.0",
    ]);
    expect(calls[0].body).toEqual({
      projectId: "p1",
      release: "v2.4.1",
      commitSha: "abc1234",
      repoUrl: "https://github.com/acme/widgets",
      deployedAt: "2026-08-22T00:00:00Z",
      previousRelease: "v2.4.0",
    });
  });

  it("400 with an unresolved previousRelease surfaces RU-4008", async () => {
    const { run, stderrLines } = harness({
      status: 400,
      body: { error: "previousRelease does not name an existing release for this project.", code: "RU-4008" },
    });
    const code = await run(["errors", "releases", "announce", "--project-id", "p1", "--release", "v2.4.1", "--previous-release", "v9.9.9"]);
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("RU-4008");
  });
});

describe("no API key configured", () => {
  it("refuses locally before ever calling fetch", async () => {
    const { run, calls, stderrLines } = harness({ status: 200, body: {} });
    const code = await run(["checks", "list"], {});
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("No API key configured");
  });
});

describe("help and unknown commands", () => {
  it("prints usage and exits 0 for help", async () => {
    const { run, stdoutLines } = harness({ status: 200, body: {} });
    const code = await run(["help"], {});
    expect(code).toBe(0);
    expect(stdoutLines[0]).toContain("Usage:");
  });

  it("prints usage and exits 1 with no arguments", async () => {
    const { run, calls } = harness({ status: 200, body: {} });
    const code = await run([], {});
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("an unknown resource is a clean CliError, not a crash", async () => {
    const { run, stderrLines } = harness({ status: 200, body: {} });
    const code = await run(["frobnicate"], {});
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain('Unknown command "frobnicate"');
  });

  it("--version prints the version and exits 0 without a key or a request (REA-223)", async () => {
    const { run, calls, stdoutLines } = harness({ status: 200, body: {} });
    const code = await run(["--version"], {});
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stdoutLines).toEqual([CLI_VERSION]);
  });

  it("CLI_VERSION matches package.json, the version the release tarball and the brew formula carry", () => {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(CLI_VERSION).toBe(pkg.version);
    expect(pkg.private).toBeUndefined();
    expect(pkg.bin).toEqual({ realuptime: "./dist/cli/bin/realuptime.js" });
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it("--api-url overrides the default host", async () => {
    const { run, calls } = harness({ status: 200, body: { checks: [] } });
    await run(["checks", "list", "--api-url", "http://localhost:3000/api/v1"]);
    expect(calls[0].url).toBe("http://localhost:3000/api/v1/checks");
  });
});

describe("realuptime errors sourcemaps upload (REA-254)", () => {
  const KEY = `rue_${"cd".repeat(16)}`;
  const DSN = `https://realuptime.io/api/errors/v1/ingest/${KEY}`;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function buildDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rea254-cli-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js.map"), '{"version":3,"sources":["../src/app.ts"],"mappings":"AAAA"}');
    writeFileSync(join(dir, "assets", "vendor.js.map"), '{"version":3,"sources":[],"mappings":""}');
    writeFileSync(join(dir, "assets", "app.js"), "x");
    return dir;
  }
  const uploadOk = {
    status: 200,
    body: {
      stored: 2,
      replaced: 1,
      release: "v2.4.1",
      files: [{ name: "assets/app.js.map", size: 60 }],
      limits: { maxFilesPerRelease: 50, maxBytesPerFile: 2097152 },
    },
  };

  it("POSTs the maps to the sourcemaps endpoint derived from the DSN, with no bearer header and no API key needed", async () => {
    const dir = buildDir();
    const { run, calls, stdoutLines, stderrLines } = harness(uploadOk);
    const code = await run(["errors", "sourcemaps", "upload", dir, "--release", "v2.4.1", "--json"], { REALUPTIME_ERRORS_DSN: DSN });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`https://realuptime.io/api/errors/v1/sourcemaps/${KEY}`);
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[0].body).toEqual({
      release: "v2.4.1",
      files: [
        { name: "assets/app.js.map", content: '{"version":3,"sources":["../src/app.ts"],"mappings":"AAAA"}' },
        { name: "assets/vendor.js.map", content: '{"version":3,"sources":[],"mappings":""}' },
      ],
    });
    const summary = JSON.parse(stdoutLines[0]);
    expect(summary).toMatchObject({ release: "v2.4.1", uploaded: 2, stored: 2, replaced: 1 });
    expect(summary.files[0]).toMatchObject({ name: "assets/app.js.map" });
    expect(summary.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // Progress on stderr, one line per batch start and end.
    expect(stderrLines[0]).toMatch(/^uploading batch 1\/1: assets\/app\.js\.map \(sha256 [0-9a-f]{12}, \d+ bytes\)/);
    expect(stderrLines[1]).toBe("batch 1/1 ok: stored 2, replaced 1");
  });

  it("a DSN on the intake host uploads to the main host, where the route lives", async () => {
    const dir = buildDir();
    const { run, calls } = harness(uploadOk);
    const intakeDsn = `https://ingest.realuptime.io/api/errors/v1/ingest/${KEY}`;
    expect(await run(["errors", "sourcemaps", "upload", dir, "--release", "v2.4.1"], { REALUPTIME_ERRORS_DSN: intakeDsn })).toBe(0);
    expect(await run(["errors", "sourcemaps", "upload", dir, "--release", "v2.4.1", "--dsn", intakeDsn], {})).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      `https://realuptime.io/api/errors/v1/sourcemaps/${KEY}`,
      `https://realuptime.io/api/errors/v1/sourcemaps/${KEY}`,
    ]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toMatchObject({ release: "v2.4.1" });
  });

  it("--dry-run reports the main host for an intake DSN, key masked", async () => {
    const dir = buildDir();
    const { run, calls, stderrLines } = harness(uploadOk);
    const intakeDsn = `https://ingest.realuptime.io/api/errors/v1/ingest/${KEY}`;
    expect(await run(["errors", "sourcemaps", "upload", dir, "--release", "v1", "--dry-run"], { REALUPTIME_ERRORS_DSN: intakeDsn })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(stderrLines[0]).toContain("to https://realuptime.io/api/errors/v1/sourcemaps/rue_...");
  });

  it("a local or self-hosted DSN keeps its own origin", async () => {
    const dir = buildDir();
    const { run, calls } = harness(uploadOk);
    await run(["errors", "sourcemaps", "upload", dir, "--release", "v1"], {
      REALUPTIME_ERRORS_DSN: `http://localhost:3000/api/errors/v1/ingest/${KEY}`,
    });
    await run(["errors", "sourcemaps", "upload", dir, "--release", "v1"], {
      REALUPTIME_ERRORS_DSN: `https://errors.example.com/api/errors/v1/ingest/${KEY}`,
    });
    expect(calls.map((call) => call.url)).toEqual([
      `http://localhost:3000/api/errors/v1/sourcemaps/${KEY}`,
      `https://errors.example.com/api/errors/v1/sourcemaps/${KEY}`,
    ]);
  });

  it("--ingest-key without --api-url uploads to the main host", async () => {
    const dir = buildDir();
    const { run, calls } = harness(uploadOk);
    await run(["errors", "sourcemaps", "upload", dir, "--release", "v1", "--ingest-key", KEY], {});
    expect(calls[0].url).toBe(`https://realuptime.io/api/errors/v1/sourcemaps/${KEY}`);
  });

  it("human output: one summary line plus one line per file with its content hash", async () => {
    const dir = buildDir();
    const { run, stdoutLines } = harness(uploadOk);
    await run(["errors", "sourcemaps", "upload", dir, "--release", "v2.4.1", "--dsn", DSN], {});
    expect(stdoutLines[0].split("\n")[0]).toBe("Uploaded 2 source maps for release v2.4.1: stored 2, replaced 1.");
    expect(stdoutLines[0].split("\n")[1]).toMatch(/^ {2}assets\/app\.js\.map {2}\d+ bytes {2}sha256 [0-9a-f]{12}$/);
  });

  it("--ingest-key with --api-url derives the endpoint from that origin", async () => {
    const dir = buildDir();
    const { run, calls } = harness(uploadOk);
    await run(["errors", "sourcemaps", "upload", dir, "--release", "v1", "--ingest-key", KEY, "--api-url", "http://localhost:3000/api/v1"], {});
    expect(calls[0].url).toBe(`http://localhost:3000/api/errors/v1/sourcemaps/${KEY}`);
  });

  it("--url-prefix prefixes every artifact name; explicit files are named by basename", async () => {
    const dir = buildDir();
    const { run, calls } = harness(uploadOk);
    await run(["errors", "sourcemaps", "upload", join(dir, "assets", "app.js.map"), "--release", "v1", "--url-prefix", "~/static/js"], {
      REALUPTIME_ERRORS_INGEST_KEY: KEY,
    });
    expect((calls[0].body as { files: { name: string }[] }).files.map((f) => f.name)).toEqual(["static/js/app.js.map"]);
  });

  it("--dry-run collects and pre-flights but never calls fetch", async () => {
    const dir = buildDir();
    const { run, calls, stdoutLines, stderrLines } = harness(uploadOk);
    const code = await run(["errors", "sourcemaps", "upload", dir, "--release", "v1", "--dry-run", "--json"], { REALUPTIME_ERRORS_DSN: DSN });
    expect(code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(JSON.parse(stdoutLines[0])).toMatchObject({ dryRun: true, release: "v1" });
    expect(stderrLines[0]).toMatch(/dry run: 2 source maps would be uploaded for release v1 to .*sourcemaps\/rue_\.\.\.$/);
  });

  it("fails locally, before any request, when no credential, no --release, no paths, or no maps are present", async () => {
    const dir = buildDir();
    const { run, calls, stderrLines } = harness(uploadOk);
    expect(await run(["errors", "sourcemaps", "upload", dir, "--release", "v1"], {})).toBe(1);
    expect(stderrLines.at(-1)).toMatch(/No ingest credential/);
    expect(await run(["errors", "sourcemaps", "upload", dir], { REALUPTIME_ERRORS_DSN: DSN })).toBe(1);
    expect(stderrLines.at(-1)).toBe("--release is required.");
    expect(await run(["errors", "sourcemaps", "upload", "--release", "v1"], { REALUPTIME_ERRORS_DSN: DSN })).toBe(1);
    expect(stderrLines.at(-1)).toMatch(/at least one directory/);
    const empty = mkdtempSync(join(tmpdir(), "rea254-cli-empty-"));
    dirs.push(empty);
    expect(await run(["errors", "sourcemaps", "upload", empty, "--release", "v1"], { REALUPTIME_ERRORS_DSN: DSN })).toBe(1);
    expect(stderrLines.at(-1)).toMatch(/No \.map files found/);
    expect(await run(["errors", "sourcemaps", "upload", join(dir, "nope"), "--release", "v1"], { REALUPTIME_ERRORS_DSN: DSN })).toBe(1);
    expect(stderrLines.at(-1)).toMatch(/Not found: .*nope\. Nothing was uploaded\./);
    expect(calls).toHaveLength(0);
  });

  it("a server refusal exits 1 with the API's own message and RU- code, untouched", async () => {
    const dir = buildDir();
    const { run, stderrLines } = harness({
      status: 403,
      body: { error: "This ingest key has been revoked. Rotate it in realuptime Errors settings.", reason: "key_revoked", code: "RU-4002" },
    });
    const code = await run(["errors", "sourcemaps", "upload", dir, "--release", "v1"], { REALUPTIME_ERRORS_DSN: DSN });
    expect(code).toBe(1);
    expect(stderrLines.at(-1)).toBe(
      "This ingest key has been revoked. Rotate it in realuptime Errors settings. Nothing was uploaded. [RU-4002]",
    );
  });

  it("is listed in the usage text", async () => {
    const { run, stdoutLines } = harness(uploadOk);
    await run(["help"]);
    expect(stdoutLines[0]).toContain("realuptime errors sourcemaps upload <dir-or-files...> --release <v>");
  });
});

describe("realuptime terraform export", () => {
  /** A stateful stub of the four routes `terraform export` reads --
   * checks/status-pages/components/channels -- keyed by path so one fetch
   * stub can answer all of them in a single command run. */
  function terraformFakeApi() {
    const calls: { method: string; path: string }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, "");
      calls.push({ method: init?.method ?? "GET", path });
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/checks") {
        return json({
          checks: [
            {
              id: "check-1",
              account_id: "acct-1",
              name: "Public API",
              url: "https://api.example.com/health",
              type: "http",
              interval_seconds: 60,
              selected_regions: ["iad", "fra"],
              assertion_body_op: null,
              assertion_body_value: null,
              assertion_body_case_sensitive: null,
              assertion_header_name: null,
              assertion_header_op: null,
              assertion_header_value: null,
              assertion_status_min: null,
              assertion_status_max: null,
              assertion_json_path: null,
              assertion_json_op: null,
              assertion_json_value: null,
            },
            { id: "check-2", account_id: "acct-1", name: "DB port", url: null, type: "tcp", interval_seconds: 60, selected_regions: ["iad"] },
          ],
        });
      }
      if (path === "/status-pages") {
        return json({
          statusPages: [
            {
              id: "page-1",
              account_id: "acct-1",
              slug: "acme",
              name: "Acme Status",
              custom_domain: null,
              page_title: null,
              page_description: null,
              logo_url: null,
              domain_status: "none",
              hide_branding: false,
              accent_color: null,
              homepage_url: null,
              support_url: null,
              theme_preset: null,
              font_choice: null,
              locale: null,
            },
          ],
        });
      }
      if (path === "/status-pages/page-1/components") {
        return json({ components: [{ id: "comp-1", status_page_id: "page-1", check_id: "check-1", display_name: "API", description: null, sort_order: 0, group_id: null }] });
      }
      if (path === "/notification-channels") {
        return json({
          channels: [
            {
              id: "chan-1",
              account_id: "acct-1",
              type: "discord",
              name: "Ops Discord",
              config_summary: "discord.com/...",
              verified_at: null,
              disabled_at: null,
              provider_configured: true,
              type_label: "Discord",
            },
          ],
        });
      }
      throw new Error(`unexpected request in terraformFakeApi: ${path}`);
    }) as FetchLike;
    return { fetchImpl, calls };
  }

  function memoryTerraformFs(initial: Record<string, string> = {}) {
    const files = new Map(Object.entries(initial));
    const fs = {
      readdir: async (dir: string) => {
        const prefix = `${dir}/`;
        return [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
      },
      mkdir: async () => {},
      writeFile: async (path: string, text: string) => {
        files.set(path, text);
      },
    };
    return { fs, files };
  }

  it("fetches checks/status-pages/components/channels and writes provider.tf, checks.tf, status_pages.tf, status_page_components.tf, notification_channels.tf, terraform.tfvars.example and import.sh", async () => {
    const { fetchImpl, calls } = terraformFakeApi();
    const { fs, files } = memoryTerraformFs();
    const stdoutLines: string[] = [];
    const code = await runCli(["terraform", "export"], {
      fetchImpl,
      env: { REALUPTIME_API_KEY: "ru_live_test" },
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
      terraformFs: fs,
    });
    expect(code).toBe(0);
    expect(calls.map((c) => c.path).sort()).toEqual(["/checks", "/notification-channels", "/status-pages", "/status-pages/page-1/components"].sort());
    expect([...files.keys()].sort()).toEqual(
      [
        "./realuptime-tf/provider.tf",
        "./realuptime-tf/checks.tf",
        "./realuptime-tf/status_pages.tf",
        "./realuptime-tf/status_page_components.tf",
        "./realuptime-tf/notification_channels.tf",
        "./realuptime-tf/terraform.tfvars.example",
        "./realuptime-tf/import.sh",
      ].sort(),
    );
    expect(files.get("./realuptime-tf/checks.tf")).toContain('resource "realuptime_check" "public_api"');
    expect(files.get("./realuptime-tf/import.sh")).toContain("terraform import realuptime_check.public_api check-1");
    expect(stdoutLines[0]).toContain("Wrote 4 resources to ./realuptime-tf");
    expect(stdoutLines[0]).toContain('Not exported (no matching provider resource): "DB port" (tcp)');
  });

  it("writes to --dir, and refuses a non-empty --dir without --force", async () => {
    const { fetchImpl } = terraformFakeApi();
    const { fs } = memoryTerraformFs({ "out/leftover.tf": "# stale\n" });
    const stderrLines: string[] = [];
    const code = await runCli(["terraform", "export", "--dir", "out"], {
      fetchImpl,
      env: { REALUPTIME_API_KEY: "ru_live_test" },
      stdout: () => {},
      stderr: (line) => stderrLines.push(line),
      terraformFs: fs,
    });
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("out is not empty");
    expect(stderrLines[0]).toContain("--force");
  });

  it("--force writes into a non-empty --dir", async () => {
    const { fetchImpl } = terraformFakeApi();
    const { fs, files } = memoryTerraformFs({ "out/leftover.tf": "# stale\n" });
    const code = await runCli(["terraform", "export", "--dir", "out", "--force"], {
      fetchImpl,
      env: { REALUPTIME_API_KEY: "ru_live_test" },
      stdout: () => {},
      stderr: () => {},
      terraformFs: fs,
    });
    expect(code).toBe(0);
    expect(files.has("out/provider.tf")).toBe(true);
  });

  it("requires an API key like every other command", async () => {
    const { fetchImpl } = terraformFakeApi();
    const { fs } = memoryTerraformFs();
    const stderrLines: string[] = [];
    const code = await runCli(["terraform", "export"], { fetchImpl, env: {}, stdout: () => {}, stderr: (line) => stderrLines.push(line), terraformFs: fs });
    expect(code).toBe(1);
    expect(stderrLines[0]).toContain("No API key configured");
  });

  it("is listed in the usage text", async () => {
    const { fs } = memoryTerraformFs();
    const stdoutLines: string[] = [];
    await runCli(["help"], { fetchImpl: (async () => new Response(null)) as FetchLike, env: {}, stdout: (line) => stdoutLines.push(line), stderr: () => {}, terraformFs: fs });
    expect(stdoutLines[0]).toContain("realuptime terraform export");
  });
});
