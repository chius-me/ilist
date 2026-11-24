(() => {
  try {
    const raw = window.localStorage.getItem('ilist.ui.preferences');
    const parsed = raw ? JSON.parse(raw) : null;
    const pref = parsed && parsed.version === 1 ? parsed : null;
    const theme = pref && (pref.theme === 'light' || pref.theme === 'dark' || pref.theme === 'system')
      ? pref.theme
      : 'system';
    const systemDark = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.dataset.theme = resolved;
    if (pref && (pref.locale === 'en' || pref.locale === 'zh-CN')) {
      document.documentElement.lang = pref.locale;
    }
  } catch {
    const systemDark = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = systemDark ? 'dark' : 'light';
  }
})();
