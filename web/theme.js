/*
 * Light or dark, decided before the first paint.
 *
 * Same rule as the app: follow the operating system unless the operator has said otherwise,
 * and only remember a choice once they actually make one. Dark is the absence of the
 * attribute; `data-theme="light"` is the only thing ever written.
 *
 * This is a separate file rather than an inline script so the content security policy can
 * refuse `unsafe-inline`. It has to run in the head, synchronously, because anything later
 * means a white flash on every load for anybody in dark mode.
 */
(function () {
  var KEY = "dscrt-keeper.theme";
  var stored = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch (e) {
    // Storage disabled. The system preference still works.
  }

  var theme =
    stored ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark");

  if (theme === "light") document.documentElement.dataset.theme = "light";

  // Handed to app.js rather than re-derived there, so there is one definition of the rule.
  window.__keeperTheme = {
    key: KEY,
    current: theme,
    set: function (next) {
      if (next === "light") document.documentElement.dataset.theme = "light";
      else delete document.documentElement.dataset.theme;
      window.__keeperTheme.current = next;
      try {
        window.localStorage.setItem(KEY, next);
      } catch (e) {
        // Nothing to do: the choice simply will not persist.
      }
    },
  };
})();
