#!/usr/bin/env node

"use strict";

const packageJson = require("../package.json");
const { runCli } = require("../lib/vttpress");

process.exitCode = runCli(process.argv.slice(2), {
  version: packageJson.version,
});
