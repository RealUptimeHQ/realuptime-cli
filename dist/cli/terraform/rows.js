/**
 * Row shapes for `realuptime terraform export` (REA-533), matching the REST
 * API's own response fields (docs/api.md "GET /checks", "GET /status-pages",
 * "Status page components", "Notification channels") -- the same snake_case
 * shape `packages/terraform-provider-realuptime/internal/client` decodes.
 * Only the fields the provider's resources actually manage are declared;
 * the API may send more (tag/status/live-state columns, other monitor
 * types' own fields) and the exporter ignores them.
 */
export {};
