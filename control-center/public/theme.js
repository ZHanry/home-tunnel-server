(function () {
  "use strict";

  var storageKey = "ht_theme";
  var preference = "system";
  try {
    var stored = window.localStorage.getItem(storageKey);
    if (stored === "dark" || stored === "light") preference = stored;
  } catch {}
  var systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;

  var locale = "zh-CN";
  try {
    var storedLocale = window.localStorage.getItem("ht_locale");
    if (storedLocale === "en" || storedLocale === "zh-CN") locale = storedLocale;
  } catch {}
  document.documentElement.lang = locale;
})();
