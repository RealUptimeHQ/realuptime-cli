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
