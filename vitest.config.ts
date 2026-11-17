import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4's default exclude no longer skips dist/, so compiled copies of the
    // tests would run a second time after `npm run build`. Only run sources.
    include: ["test/**/*.test.ts"],
    // Tests spawn git and Node processes, which is slow on Windows.
    testTimeout: 20000,
  },
});
