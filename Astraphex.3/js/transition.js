// Fade-out before leaving a page, for browsers without cross-document View Transitions (Firefox).
// shortcut: plain <a> clicks only; JS redirects (location.href) just load without the fade-out.
(function () {
  if (window.CSSViewTransitionRule || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var root = document.documentElement;
  addEventListener('pageshow', function () { root.classList.remove('pt-out'); }); // back/forward cache
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target || a.hasAttribute('download') || a.origin !== location.origin) return;
    if (a.pathname === location.pathname && a.search === location.search) return; // same page / #hash
    e.preventDefault();
    root.classList.add('pt-out');
    setTimeout(function () { location.href = a.href; }, 160);
  });
})();
