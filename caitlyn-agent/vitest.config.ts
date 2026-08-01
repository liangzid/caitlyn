import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    pool: "forks",
    isolate: true,
    setupFiles: ["tests/setup-library-isolation.ts"],
  },
});
