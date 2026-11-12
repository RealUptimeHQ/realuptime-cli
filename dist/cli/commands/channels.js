import { flagString, requireFlagString } from "../args.js";
import { CliError } from "../errors.js";
import { apiRequest } from "../http.js";
/** `GET /notification-channels`: the registry's channels, and under
 * `builtIn` the two destinations every account has (email to the account
 * owner, and the account's Slack webhook). */
export function channelsList(client) {
    return apiRequest(client, { path: "/notification-channels" });
}
const WEBHOOK_TYPES = ["slack", "discord", "msteams", "firehydrant"];
/**
 * `POST /notification-channels`.
 *
 * A channel's destination is a credential, so each one can come from the
 * environment instead of the command line: `--webhook-url` falls back to
 * REALUPTIME_ALERT_WEBHOOK_URL and `--channel-api-key` to
 * REALUPTIME_CHANNEL_API_KEY. A flag, when given, wins.
 *
 * Config by type, as the API names it: slack, discord, msteams and
 * firehydrant take `webhookUrl`; generic_json takes `url`; opsgenie takes
 * `apiKey` and `region`; incidentio takes `apiKey` and
 * `alertSourceConfigId`. email takes none: it is the account owner's address.
 */
export function channelsCreate(client, flags, env) {
    const type = requireFlagString(flags, "type");
    const body = { type };
    const name = flagString(flags, "name");
    if (name !== undefined)
        body.name = name;
    else if (type !== "email" && type !== "slack")
        throw new CliError("--name is required.");
    const config = {};
    const webhookUrl = flagString(flags, "webhook-url") ?? env.REALUPTIME_ALERT_WEBHOOK_URL;
    const channelApiKey = flagString(flags, "channel-api-key") ?? env.REALUPTIME_CHANNEL_API_KEY;
    if (type === "generic_json") {
        const url = flagString(flags, "url") ?? webhookUrl;
        if (url !== undefined)
            config.url = url;
    }
    else if (type === "opsgenie" || type === "incidentio") {
        if (channelApiKey !== undefined)
            config.apiKey = channelApiKey;
        const region = flagString(flags, "region");
        if (region !== undefined)
            config.region = region;
        const sourceId = flagString(flags, "alert-source-config-id");
        if (sourceId !== undefined)
            config.alertSourceConfigId = sourceId;
    }
    else if (WEBHOOK_TYPES.includes(type)) {
        if (webhookUrl === undefined) {
            throw new CliError("--webhook-url is required (or set REALUPTIME_ALERT_WEBHOOK_URL).");
        }
        config.webhookUrl = webhookUrl;
    }
    if (Object.keys(config).length > 0)
        body.config = config;
    return apiRequest(client, { method: "POST", path: "/notification-channels", body });
}
/** `POST /notification-channels/:id/test`: sends one real test alert. The
 * API answers 200 either way; `ok: false` carries the destination's refusal,
 * and `runCli` turns that into a non-zero exit. */
export function channelsTest(client, id) {
    if (!id) {
        throw new CliError("Usage: realuptime channels test <id>");
    }
    return apiRequest(client, { method: "POST", path: `/notification-channels/${encodeURIComponent(id)}/test` });
}
