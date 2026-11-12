/**
 * The CLI's own version, printed by `realuptime --version`. A constant
 * rather than a runtime read of package.json so the compiled dist/ has no
 * file-system dependency on where it was installed (brew's libexec, a global
 * npm prefix, a checkout). `./cli.test.ts` pins it to package.json's
 * "version" so the two cannot drift, and `scripts/publish-cli.mjs` refuses
 * to cut a release when they disagree.
 */
export const CLI_VERSION = "0.3.1"; // x-release-please-version
