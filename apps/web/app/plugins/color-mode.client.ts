// Colour mode + document-type colour variables (dark-mode change). Runs before
// the app mounts, so the first render already has the right theme.
export default defineNuxtPlugin(() => {
  if (typeof document !== "undefined" && !document.getElementById("aktenraum-family-colors")) {
    const style = document.createElement("style");
    style.id = "aktenraum-family-colors";
    style.textContent = familyColorCss();
    document.head.appendChild(style);
  }
  startColorMode();
});
