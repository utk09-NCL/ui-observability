#!/usr/bin/env node
// bin/uiobs.mjs
//
// Runs the package's command line tool. The code lives in dist/doctor.js.

import { main } from "../dist/doctor.js";

process.exitCode = await main(process.argv.slice(2), console.log);
