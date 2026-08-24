#!/usr/bin/env node
// Plain `node`, not `node --experimental-strip-types`: Node 22.18+ strips
// types by default, so running this .ts file straight from a checkout still
// works, and the SAME shebang is what tsc carries into dist/bin/realuptime.js,
// the file the published package's "bin" actually points at (REA-223).
import { runCli } from "../cli.ts";

const exitCode = await runCli(process.argv.slice(2));
process.exit(exitCode);
