/* Hemma hero — 3D contour terrain.
   Hand-rolled perspective projection (no Three.js): a slowly undulating
   ridge of topographic lines + points, drawn with the design tokens so it
   follows light/dark theme switches live. */
(function () {
  'use strict';

  var canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  var ctx = canvas.getContext('2d');
  var wrap = canvas.parentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Scene constants ─────────────────────────────────────────
  var ROWS = 26;            // contour lines (depth)
  var SPAN_X = 1.3;         // half-width of terrain in world units
  var SPAN_Z = 1.55;        // depth of terrain in world units
  var FOV = 1.6;            // perspective strength
  var CAM = 1.4;            // camera distance beyond rotation origin
  var BASE_PITCH = -0.55;   // camera looks down at the ridge

  var W = 0, H = 0, DPR = 1, COLS = 96;
  var raf = null;
  var t0 = null;

  // Pointer parallax — target set on pointermove, eased every frame
  var targetYaw = 0, targetPitch = 0, yaw = 0, pitchOff = 0;

  var colors = { accent: [46, 93, 62], copper: [176, 107, 56] };

  function parseToken(style, name, fallback) {
    var v = style.getPropertyValue(name).trim().replace('#', '');
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    var n = parseInt(v, 16);
    if (isNaN(n)) return fallback;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function readColors() {
    var style = getComputedStyle(document.documentElement);
    colors.accent = parseToken(style, '--accent-light', colors.accent);
    colors.copper = parseToken(style, '--copper', colors.copper);
  }

  function rgba(rgb, a) {
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
  }

  // ── Terrain elevation: layered travelling sines ─────────────
  function elevation(x, z, time) {
    return 0.16 * Math.sin(x * 2.1 + time * 0.55)
         + 0.11 * Math.sin(x * 3.7 - z * 2.3 + time * 0.35)
         + 0.07 * Math.sin((x + z) * 5.3 + time * 0.7)
         + 0.05 * Math.sin(z * 4.1 - time * 0.45);
  }

  // ── Perspective projection ──────────────────────────────────
  function project(x, y, z) {
    var zc = z - SPAN_Z / 2;
    // yaw (around Y), then pitch (around X)
    var cy = Math.cos(yaw), sy = Math.sin(yaw);
    var x1 = x * cy - zc * sy;
    var z1 = x * sy + zc * cy;
    var pitch = BASE_PITCH + pitchOff;
    var cx = Math.cos(pitch), sx = Math.sin(pitch);
    var y2 = y * cx - z1 * sx;
    var z2 = y * sx + z1 * cx;
    var s = FOV / (FOV + z2 + CAM);
    return {
      x: W * 0.5 + x1 * s * W * 0.55,
      y: H * 0.55 - y2 * s * H * 0.85,
      s: s
    };
  }

  function draw(time) {
    ctx.clearRect(0, 0, W, H);
    for (var r = ROWS - 1; r >= 0; r--) {
      var z = (r / (ROWS - 1)) * SPAN_Z;
      var isCopper = r % 6 === 3;
      var rgb = isCopper ? colors.copper : colors.accent;
      var first = null;
      ctx.beginPath();
      for (var c = 0; c <= COLS; c++) {
        var x = (c / COLS) * SPAN_X * 2 - SPAN_X;
        var p = project(x, elevation(x, z, time), z);
        if (c === 0) { ctx.moveTo(p.x, p.y); first = p; }
        else ctx.lineTo(p.x, p.y);
      }
      var depth = first.s; // ~0.42 far → ~0.8 near
      ctx.strokeStyle = rgba(rgb, (isCopper ? 0.30 : 0.38) * depth * depth);
      ctx.lineWidth = 1.1 * depth;
      ctx.stroke();
      // points at every 4th column ride the same contour
      ctx.fillStyle = rgba(rgb, 0.5 * depth * depth);
      for (var d = 2; d < COLS; d += 4) {
        var xd = (d / COLS) * SPAN_X * 2 - SPAN_X;
        var pd = project(xd, elevation(xd, z, time), z);
        ctx.beginPath();
        ctx.arc(pd.x, pd.y, 1.4 * pd.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function frame(ts) {
    if (t0 === null) t0 = ts;
    yaw += (targetYaw - yaw) * 0.04;
    pitchOff += (targetPitch - pitchOff) * 0.04;
    draw((ts - t0) * 0.001);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf === null && !reduceMotion) raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = wrap.clientWidth;
    H = wrap.clientHeight;
    COLS = W < 640 ? 64 : 96;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (reduceMotion) draw(7.3); // single elegant still
  }

  // ── Wiring ──────────────────────────────────────────────────
  window.addEventListener('resize', resize);

  if (!reduceMotion) {
    wrap.addEventListener('pointermove', function (e) {
      var rect = wrap.getBoundingClientRect();
      targetYaw = ((e.clientX - rect.left) / rect.width - 0.5) * 0.14;
      targetPitch = ((e.clientY - rect.top) / rect.height - 0.5) * 0.07;
    });
    wrap.addEventListener('pointerleave', function () {
      targetYaw = 0;
      targetPitch = 0;
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });
  }

  // Re-read token colours when the theme flips
  new MutationObserver(function () {
    readColors();
    if (reduceMotion) draw(7.3);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  readColors();
  resize();
  start();
}());
