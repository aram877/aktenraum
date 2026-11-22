# Design

## Decisions

### D1. Class on `<html>`, always set by the client
Tailwind v4 emits the theme tokens as CSS variables in `:root` (theme layer). An unlayered `:root.dark { … }` block overrides them, and `@custom-variant dark (&:where(.dark, .dark *))` makes `dark:` classes follow the same class. A client plugin (`plugins/color-mode.client.ts`) always sets either `dark` or `light`, resolving "System" with `matchMedia("(prefers-color-scheme: dark)")` and listening for changes. The page only renders after the JS bundle loads (`ssr: false`), so there's no wrong-theme content flash. A tiny `@media (prefers-color-scheme: dark) html:not(.light)` rule colours the background before JS runs. No inline script is needed, so `script-src 'self'` stays intact.

### D2. Preference logic is a pure util
`utils/color-mode.ts`: `parseColorMode` (unknown → `system`), `resolveColorMode(mode, systemDark)`, `nextColorMode` (system → light → dark → system), and `colorModeLabel`. The composable `useColorMode` wraps it with `localStorage` (key `aktenraum-color-mode`; read/write in try/catch, so private windows and blocked storage fall back to System).

### D3. Area colours as variables generated from TypeScript
`doc-types.ts` keeps the hex values (`light: {tint, ink}`, `dark: {tint, ink}`, one `fill`) for the contrast test, and exposes `tint` / `ink` as `var(--fam-<key>-tint|ink)`. `familyColorCss()` builds the `:root` + `:root.dark` rules; the plugin injects them once as a `<style>` element (`style-src 'unsafe-inline'` is already allowed). There's no second copy in CSS to drift.

### D4. Remap the used Tailwind shades instead of adding `dark:` everywhere
About 30 files use `bg-red-50`, `text-red-700`, `bg-amber-50`, `text-emerald-800` and similar for alerts. In `:root.dark` those palette variables get dark-tint backgrounds and light text values, so alert boxes read correctly without touching each file. Only the shades the app actually uses are remapped. Literal `bg-white` becomes `bg-surface`.

## Risks / Trade-offs

- Remapping `red-700` to a light red means a future component that wants a dark red text on a light box in dark mode can't get it. That's acceptable: in dark mode every such box is dark.
- Tile fills are unchanged; on the dark canvas they still read as solid colour blocks with white text (contrast unchanged).
