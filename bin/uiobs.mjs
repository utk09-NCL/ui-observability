#!/usr/bin/env node
// bin/uiobs.mjs
//
// Runs the command line tool of the package. The code is in dist/doctor.js.

import { main } from "../dist/doctor.js";

process.exitCode = await main(process.argv.slice(2), console.log);
