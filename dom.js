(function () {
  'use strict';

  window.App = window.App || {};

  function set(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    var changed = el.textContent !== String(text);
    el.textContent = text;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
    // Subtle "recalculated" flash; class is dropped on animationend below
    if (changed && !el.classList.contains('val-flash')) el.classList.add('val-flash');
  }

  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'val-flash') e.target.classList.remove('val-flash');
  });

  function val(id) {
    var el = document.getElementById(id);
    if (!el) return 0;
    if (el.dataset.type === 'currency') return App.calc.parseFormatted(el.value);
    return parseFloat(el.value) || 0;
  }

  window.App.dom = {
    set: set,
    val: val,
  };
}());
