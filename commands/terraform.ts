import type { ParsedArgs } from "../args.ts";
import { flagBoolean, flagString } from "../args.ts";
import { CliError } from "../errors.ts";
import { apiRequest, type ClientConfig } from "../http.ts";
import { buildTerraformExport } from "../terraform/export.ts";
import type { ApiChannelRow, ApiCheckRow, ApiComponentRow, ApiStatusPageRow } from "../terraform/rows.ts";

export const DEFAULT_TERRAFORM_DIR = "./realuptime-tf";

/** Filesystem surface `terraform export` needs, beyond `apply`/`export`/`validate`'s
 * `FileSystemLike` (mac.ts): a directory of files, not one file, so this
 * also needs to list and create directories. Injectable for the same
 * reason -- tests run against an in-memory map, never the real disk. */
export interface TerraformFileSystemLike {
  /** Lists a directory's entries; resolves to `[]` for a directory that
   * doesn't exist yet (mirrors `--force`'s "empty or absent is fine" check). */
  readdir(path: string): Promise<string[]>;
  mkdir(path: string): Promise<void>;
  writeFile(path: string, text: string): Promise<void>;
}

export interface TerraformContext {
  client: ClientConfig;
  fs: TerraformFileSystemLike;
  stdout: (line: string) => void;
}

async function fetchAll(client: ClientConfig) {
  const [checksBody, statusPagesBody, channelsBody] = await Promise.all([
    apiRequest<{ checks: ApiCheckRow[] }>(client, { path: "/checks" }),
    apiRequest<{ statusPages: ApiStatusPageRow[] }>(client, { path: "/status-pages" }),
    apiRequest<{ channels: ApiChannelRow[] }>(client, { path: "/notification-channels" }),
  ]);
  const statusPages = statusPagesBody.statusPages ?? [];
  const componentsByStatusPageId = new Map<string, ApiComponentRow[]>();
  await Promise.all(
    statusPages.map(async (page) => {
      const body = await apiRequest<{ components: ApiComponentRow[] }>(client, { path: `/status-pages/${encodeURIComponent(page.id)}/components` });
      componentsByStatusPageId.set(page.id, body.components ?? []);
    }),
  );
  return {
    checks: checksBody.checks ?? [],
    statusPages,
    componentsByStatusPageId,
    channels: channelsBody.channels ?? [],
  };
}

/**
 * `realuptime terraform export [--dir <path>] [--force]` (REA-533): reads
 * the account's checks, status pages, components and notification channels
 * through the REST API and writes `.tf` files matching
 * `packages/terraform-provider-realuptime`'s actual resource schemas, plus
 * an `import.sh` so `terraform import` brings each one under management
 * without Terraform wanting to recreate it. See `cli/terraform/`
 * for the HCL builders this wraps.
 */
export async function terraformExportCommand(ctx: TerraformContext, flags: ParsedArgs["flags"]): Promise<number> {
  const dir = flagString(flags, "dir") ?? DEFAULT_TERRAFORM_DIR;
  const force = flagBoolean(flags, "force");

  const existing = await ctx.fs.readdir(dir);
  if (existing.length > 0 && !force) {
    throw new CliError(`${dir} is not empty. Pass --force to write into it anyway (existing files with the same name are overwritten).`);
  }

  const data = await fetchAll(ctx.client);
  const result = buildTerraformExport(data);

  await ctx.fs.mkdir(dir);
  for (const file of result.files) {
    await ctx.fs.writeFile(`${dir}/${file.path}`, file.content);
  }

  const total = result.counts.checks + result.counts.statusPages + result.counts.components + result.counts.channels;
  const lines = [
    `Wrote ${total} resource${total === 1 ? "" : "s"} to ${dir}: ${result.counts.checks} check${result.counts.checks === 1 ? "" : "s"}, ` +
      `${result.counts.statusPages} status page${result.counts.statusPages === 1 ? "" : "s"}, ${result.counts.components} component${result.counts.components === 1 ? "" : "s"}, ` +
      `${result.counts.channels} notification channel${result.counts.channels === 1 ? "" : "s"}.`,
  ];
  if (result.skipped.length > 0) {
    lines.push(`Not exported (no matching provider resource): ${result.skipped.map((s) => `${JSON.stringify(s.name)} (${s.type})`).join(", ")}.`);
  }
  if (result.importCommands.length > 0) {
    lines.push(`Run ${dir}/import.sh (after \`terraform init\`) to import these into state without recreating them.`);
  }
  if (result.files.some((f) => f.path === "terraform.tfvars.example")) {
    lines.push(`Notification channel credentials are never exported (the API never returns them): copy ${dir}/terraform.tfvars.example to terraform.tfvars and fill in the real values.`);
  }
  ctx.stdout(lines.join("\n"));
  return 0;
}
