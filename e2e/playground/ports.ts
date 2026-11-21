// e2e/playground/ports.ts
//
// The ports and origins of the playground smoke test. None of them is a dev port of an example
// or a port of e2e/fixtures/ingest.ts, so a running example doesn't clash with a test run.

/** Port of the react-custom-backend dev server. The mock ingest server lists its origin. */
export const APP_PORT = 5186;

/** Port of the react (FX workspace) dev server. The mock ingest server lists its origin. */
export const REACT_PORT = 5187;

/** Port of the mock ingest server. */
export const INGEST_PORT = 8797;

/** Port of the mock app API. */
export const APP_API_PORT = 8798;

export const REACT_ORIGIN = `http://localhost:${String(REACT_PORT)}`;
export const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;
export const INGEST_ORIGIN = `http://localhost:${String(INGEST_PORT)}`;
export const APP_API_ORIGIN = `http://localhost:${String(APP_API_PORT)}`;
