import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Core code of the API (NFR5). The entry point and the scripts are tested against real nodes instead.
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
