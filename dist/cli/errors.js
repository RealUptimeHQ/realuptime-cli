/**
 * The CLI's own error type (REA-180). Every command that talks to the API
 * throws this on a non-2xx response, carrying the API's own `error`
 * message, its stable `RU-XXXX` code, and its KB link verbatim -- the CLI
 * never invents its own copy for a server-side refusal (docs/api.md
 * "CLI"). A usage mistake the CLI catches itself (missing a required flag,
 * an unknown subcommand) throws the same type with no `code`, so both kinds
 * render through one path in `output.ts`.
 */
export class CliError extends Error {
    code;
    docs;
    httpStatus;
    constructor(message, opts = {}) {
        super(message);
        this.name = "CliError";
        this.code = opts.code;
        this.docs = opts.docs;
        this.httpStatus = opts.httpStatus;
    }
}
export function isCliError(value) {
    return value instanceof CliError;
}
