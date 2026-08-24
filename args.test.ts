import { describe, expect, it } from "vitest";
import { flagBoolean, flagList, flagNumber, flagString, parseArgs, requireFlagString } from "./args.ts";
import { CliError } from "./errors.ts";

describe("parseArgs", () => {
  it("splits positionals from --flag value pairs", () => {
    const { positionals, flags } = parseArgs(["checks", "create", "--name", "API", "--url", "https://example.com"]);
    expect(positionals).toEqual(["checks", "create"]);
    expect(flags).toEqual({ name: "API", url: "https://example.com" });
  });

  it("accepts --flag=value form", () => {
    const { flags } = parseArgs(["--name=API"]);
    expect(flags).toEqual({ name: "API" });
  });

  it("treats a trailing --flag, or one followed by another --flag, as boolean true", () => {
    expect(parseArgs(["--force"]).flags).toEqual({ force: true });
    expect(parseArgs(["--force", "--json"]).flags).toEqual({ force: true, json: true });
  });

  it("keeps positionals in order around interspersed flags", () => {
    const { positionals } = parseArgs(["incidents", "update", "abc-123", "--status", "resolved"]);
    expect(positionals).toEqual(["incidents", "update", "abc-123"]);
  });
});

describe("flag helpers", () => {
  it("flagString returns undefined for a missing flag", () => {
    expect(flagString({}, "name")).toBeUndefined();
  });

  it("flagString throws when the flag was passed as a bare boolean", () => {
    expect(() => flagString({ name: true }, "name")).toThrow(CliError);
  });

  it("requireFlagString throws a CliError naming the missing flag", () => {
    expect(() => requireFlagString({}, "name")).toThrow(/--name is required/);
  });

  it("flagBoolean treats only true/\"true\" as true", () => {
    expect(flagBoolean({ force: true }, "force")).toBe(true);
    expect(flagBoolean({ force: "true" }, "force")).toBe(true);
    expect(flagBoolean({ force: "false" }, "force")).toBe(false);
    expect(flagBoolean({}, "force")).toBe(false);
  });

  it("flagNumber parses a numeric string and rejects a non-numeric one", () => {
    expect(flagNumber({ limit: "42" }, "limit")).toBe(42);
    expect(flagNumber({}, "limit")).toBeUndefined();
    expect(() => flagNumber({ limit: "fast" }, "limit")).toThrow(/--limit must be a number/);
  });

  it("flagList splits on commas, trims, and drops empty segments", () => {
    expect(flagList({ regions: "iad, fra ,,sjc" }, "regions")).toEqual(["iad", "fra", "sjc"]);
    expect(flagList({}, "regions")).toBeUndefined();
  });
});
