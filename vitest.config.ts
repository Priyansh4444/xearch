import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "apps/collector/tests/**/*.test.ts",
      "apps/web/src/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/.delta/**", "apps/posthog-export/**"],
  },
});
