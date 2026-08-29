// src/index.ts
//
// This is the only public entry point. package.json's exports map points
// only here, so re-export everything a consumer should be able to import.
//
// Keep this file free of side effects. package.json promises sideEffects:
// false, meaning importing this module does nothing by itself. If you add a
// side effect anyway, a bundler will still believe that promise, strip the
// side effect out, and quietly break whatever depended on it running.
export {};
