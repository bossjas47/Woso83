// Loaded synchronously in <head> so the saved theme applies before first paint.
try { if (localStorage.getItem('theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch (_) {}
window.toggleTheme = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (_) {}
  document.dispatchEvent(new Event('themechange'));
};
