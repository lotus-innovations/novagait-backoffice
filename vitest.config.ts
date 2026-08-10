import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "evals/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
  },
});
