// src/index.ts
//
// The single public entry point. The exports map names this file and nothing
// else, so anything a consumer is meant to reach is re-exported here by name.
//
// Stays side-effect free. `sideEffects: false` in package.json is only true
// while importing this module does no work, and a bundler acting on that field
// will tree-shake away code a side effect here depended on.
export {};
