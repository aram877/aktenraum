# Tasks

- [x] 1.1 `utils/color-mode.ts` + `composables/useColorMode.ts` + `plugins/color-mode.client.ts`; verify with unit tests (parse, resolve, cycle) and a test that storage errors fall back to System.
- [x] 1.2 Dark tokens, `tone-*` tokens, palette remap, `@custom-variant dark`, pre-JS background in `main.css`; family colours as generated variables (`familyColorCss`); replace hard-coded hex / `bg-white` in components; verify with the extended contrast test.
- [x] 1.3 Toggle in AppNav (desktop + drawer); verify with a nav test (cycles System → Hell → Dunkel, sets the class, stores the choice).
- [x] 1.4 CLAUDE.md, session note; `pnpm -r lint`, `pnpm -r build`, web typecheck, `pnpm -r test`; rebuild nginx and check light + dark in the browser.
