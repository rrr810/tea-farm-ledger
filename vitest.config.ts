import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["packages/**/src/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 15000,
  },
});
