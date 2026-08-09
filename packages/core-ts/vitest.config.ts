import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // No tests exist yet for this freshly-scaffolded package (tasks.md 3.9
    // adds the first ones) — don't fail CI on an empty suite in the meantime.
    passWithNoTests: true,
  },
});
