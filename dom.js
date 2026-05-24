(function () {
  'use strict';

  window.App = window.App || {};

  function set(id, text, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('positive', 'negative');
    if (cls) el.classList.add(cls);
  }

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
