import { flagBoolean, flagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
import { buildTerraformExport } from "../terraform/export.js";
export const DEFAULT_TERRAFORM_DIR = "./realuptime-tf";
async function fetchAll(client) {
    const [checksBody, statusPagesBody, channelsBody] = await Promise.all([
        apiRequest(client, { path: "/checks" }),
        apiRequest(client, { path: "/status-pages" }),
        apiRequest(client, { path: "/notification-channels" }),
    ]);
    const statusPages = statusPagesBody.statusPages ?? [];
    const componentsByStatusPageId = new Map();
    await Promise.all(statusPages.map(async (page) => {
        const body = await apiRequest(client, { path: `/status-pages/${encodeURIComponent(page.id)}/components` });
        componentsByStatusPageId.set(page.id, body.components ?? []);
    }));
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
export async function terraformExportCommand(ctx, flags) {
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
