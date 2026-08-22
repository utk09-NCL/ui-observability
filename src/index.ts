// src/index.ts
//
// The single public entry point. The package's exports map names this file and
// nothing else, so anything a consumer is meant to reach has to be re-exported
// here by name. That is what stops framework adapters and deep imports from
// growing into the API by accident.
//
// It stays side-effect free. `sideEffects: false` in package.json is only
// truthful while importing this module does no work at import time, and
// bundlers act on that field, so a top level side effect added here does not
// merely bend the rule: it lets a bundler tree-shake away code you needed.
export {};
