// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "happy-dom",
		setupFiles: ["./tests/setup.ts"],
		restoreMocks: true,
		unstubGlobals: true,
		// src/ and tests/ only. The example workspaces are applications, not library
		// code, and a stray *.test.ts inside one must not join this run.
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "html", "lcov", "json"],
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			thresholds: {
				lines: 100,
				functions: 100,
				branches: 100,
				statements: 100,
			},
		},
	},
});
