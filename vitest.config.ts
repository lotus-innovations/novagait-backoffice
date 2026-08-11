import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Next's "@/..." alias for apps/web sources (route-handler tests).
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: [
      "packages/**/*.test.ts",
      "evals/**/*.test.ts",
      "apps/**/*.test.ts",
    ],
  },
});
