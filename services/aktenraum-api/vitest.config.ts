import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    passWithNoTests: true,
    // Login tests run real bcrypt (cost 12, also for unknown users — timing
    // equality) 10+ times per test; on GitHub's 2-4 core runners that crossed
    // vitest's 5 s default (CI red 2026-11-20/21: 5.07-5.14 s). Hangs still fail.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
