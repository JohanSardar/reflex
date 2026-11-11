#!/usr/bin/env node
// The reflex CLI. Node runs the TypeScript sources directly (type stripping).
import { main } from "../src/surfaces/cli.ts";

const code = await main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
