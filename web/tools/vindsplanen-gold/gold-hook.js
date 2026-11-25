// ---- vindsplanen gold hook (appended into the v41 module by make-copy.sh) ----
// Runs v41's own functions on a given plan and returns their results, so the
// TypeScript port can be checked against the oracle. Not part of the app.
// Free names (state, sanitize, THREE, L, …) are v41 module-scope bindings.
{
  const R = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v * 1e4) / 1e4) : String(v)) : v);
  const deep = (v) => JSON.parse(JSON.stringify(v, (k, x) => R(x)));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const meshList = (objs) => objs.map((o) => {
    const g = o.geometry, p = {};
    if (g && g.parameters) for (const [k, v] of Object.entries(g.parameters)) if (typeof v === 'number') p[k] = v;
    const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(o.quaternion);
    const parent = Object.entries(belowCut).find(([, grp]) => grp === o.parent);
    return { type: o.type, geo: g ? g.type : null, params: p, pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], dir: dir.toArray(), cut: parent ? parent[0] : '' };
  });
  const planData = (P) => ({ n: P.n, r: P.r, g: P.g, F: P.F, treads: P.treads, opening: P.opening, arrive: P.arrive, turn: P.turn, pivot: P.pivot, a: P.a, wk: P.wk, landing: P.landing, spiral: !!P.spiral });
  // a small deterministic generator, mirrored in the tests
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

  window.__gold = (input, opts = {}) => {
    state = sanitize(clone(opts.useExample ? examplePlan() : input));
    delete state._addStorage; delete state._refitStorage;
    if (opts.addCurved) state.items.push({ ...makeItem('curved'), id: 'c1' });
    if (opts.addStorage) state.items.push({ ...makeItem('storage'), id: 'st1' });
    if (opts.addCloset) { const st = state.items.find((i) => i.type === 'curved'); state.items.push({ ...makeItem('closet'), id: 'cl1', side: st && st.z > 0 ? 'S' : 'N' }); }
    const setup = clone(state);
    const out = { input: setup };
    out.makeItems = {};
    for (const t of ADD_ORDER) { const it = makeItem(t); delete it.id; out.makeItems[t] = it; }
    rebuildAll();
    out.afterBuild = clone(state);
    out.geometry = { L, H, KZ, HALF, W, SLOPE, THETA, SLEN, SIN, COS, KNEE_H, Z190, ZBOA, RAFT_X, EDGES, BAYS, BOARD_D, BOARD_DY, ATTIC };
    const ceil = [];
    for (let x = 0; x <= L + 1e-9; x += 0.25) for (let z = -HALF - 0.1; z <= HALF + 0.1 + 1e-9; z += 0.25) ceil.push([x, z, ceilAt(x, z)]);
    out.ceil = ceil;
    out.warnings = Object.fromEntries(warnings);
    out.skyHoleOk = [...skyHoleOk];
    out.gableFit = gableWindowFit(state.options.gable).fits;
    const B = state.options.below;
    out.holes = {};
    for (const [name, lim] of [['KZ', KZ], ['HALF', HALF], ['hw', B.hw]]) { const hs = stairHoles(lim); out.holes[name] = { holes: hs, clash: [...holeClash] }; }
    stairHoles(KZ);
    out.info = {};
    for (const it of state.items) {
      if (it.type === 'curved' || it.type === 'spiral') {
        const c = curvedInfo(it);
        out.info[it.id] = { head: c.head, downHead: c.downHead, minFree: c.minFree, P: planData(c.P) };
        if (it.type === 'curved') out.info[it.id].rails = meshList(stairRails(it, c.P).children);
      } else if (it.type === 'stairs') { const s = stairInfo(it); out.info[it.id] = { n: s.n, rise: s.rise, going: s.going, blondel: s.blondel, minHead: s.minHead, inside: stairsInside(it) }; }
      else if (it.type === 'skylight') { const s = skyInfo(it); out.info[it.id] = { sBot: s.sBot, sTop: s.sTop, topY: s.topY, bay: s.bay, rect: skyRect(it) }; }
      else if (it.type === 'storage') { const S = storageGeom(it); out.info[it.id] = { ...S, shared: undefined, sharedX0: S.shared(S.x0), sharedX1: S.shared(S.x1), fit: storageFit(it.side) }; }
      else if (it.type === 'closet') out.info[it.id] = closetGeom(it);
    }
    out.below = { F: FF(), sw: swRect(), hall: hallRect(), oldW: OLD_W(), win: belowWin(), old: (() => { const o = oldStairs(); return { it: o.it, P: planData(o.P) }; })() };
    buildBelow();
    out.below.parts = meshList(belowParts);
    // zones: v41 paints alpha 95 (standing), 80 (BOA), 0 (neither, or an opening)
    computeZones();
    const img = zoneCanvas.getContext('2d').getImageData(0, 0, NX, NZ).data;
    let cells = '';
    for (let k = 0; k < NX * NZ; k++) { const a = img[k * 4 + 3]; cells += a === 95 ? 'S' : a === 80 ? 'B' : '.'; }
    out.zones = { nx: NX, nz: NZ, cells, floor: $('#st-floor').textContent, stand: $('#st-stand').textContent, boa: $('#st-boa').textContent, rooms: [...$('#rooms').children].map((d) => d.textContent) };
    // walk
    fpSurfaces();
    const F = FF(), OSn = oldStairs(), WH = ['attic', 'below', 'old', 'new', 'ground'];
    const feetLevels = [0, -F / 2, -F, -F - OSn.P.F];
    const grid = [];
    for (const feet of feetLevels) for (let x = 0; x <= L + 1e-9; x += 0.25) for (let z = -HALF; z <= HALF + 1e-9; z += 0.25) {
      const g = fpGround(x, z, feet);
      grid.push(g ? [WH.indexOf(g.where), g.y, fpHeadroom(x, z, g.y)] : [-1, 0, fpHeadroom(x, z, feet)]);
    }
    const walks = {};
    for (const where of ['below', 'attic']) {
      fpPlace(where);
      const start = { x: FP.x, z: FP.z, feet: FP.feet, yaw: FP.yaw, where: FP.where };
      const rnd = lcg(where === 'below' ? 7 : 11); let yaw = FP.yaw; const steps = [];
      for (let i = 0; i < 400; i++) {
        yaw += (rnd() - 0.5) * 0.6;
        const ok = fpTry(FP.x + Math.cos(yaw) * 0.08, FP.z + Math.sin(yaw) * 0.08);
        if (!ok) yaw += Math.PI / 2 + rnd() * Math.PI;
        steps.push([ok ? 1 : 0, FP.x, FP.z, FP.feet, FP.where, fpHeadroom(FP.x, FP.z, FP.feet)]);
      }
      walks[where] = { start, steps };
    }
    // guided routes: up the new stairs tread by tread, and down the old stairs to the ground floor
    const centre = (s) => s.poly ? s.poly.reduce((a, q) => [a[0] + q[0] / s.poly.length, a[1] + q[1] / s.poly.length], [0, 0]) : [(s.rect[0] + s.rect[1]) / 2, (s.rect[2] + s.rect[3]) / 2];
    const route = (start, targets) => {
      Object.assign(FP, { x: start[0], z: start[1], feet: start[2], where: start[3] });
      const steps = [];
      for (const [tx, tz] of targets) for (let i = 0; i < 80; i++) {
        const dx = tx - FP.x, dz = tz - FP.z, d = Math.hypot(dx, dz); if (d < 0.03) break;
        const s = Math.min(0.05, d), ok = fpTry(FP.x + (dx / d) * s, FP.z + (dz / d) * s);
        steps.push([ok ? 1 : 0, FP.x, FP.z, FP.feet, FP.where, fpHeadroom(FP.x, FP.z, FP.feet)]);
        if (!ok) break;
      }
      return steps;
    };
    const routes = {};
    const nu = FP.surf.filter((s) => s.where === 'new'), old = FP.surf.filter((s) => s.where === 'old'), gnd = FP.surf.find((s) => s.where === 'ground');
    if (nu.length) { const c = centre(nu[0]); routes.upNew = route([c[0], c[1], nu[0].y, 'new'], nu.slice(1).map(centre)); }
    if (old.length && gnd) { const top = old[old.length - 1], c = centre(top); routes.downOld = route([c[0], c[1], top.y, 'old'], [...old.slice(0, -1).reverse().map(centre), [gnd.rect[0] + 0.3, centre(gnd)[1]]]); }
    out.walk = { feetLevels, grid, walks, routes };
    // measure registry, and each step's setters applied to a copy
    const saved = clone(state);
    const steps = walkSteps();
    out.measure = steps.map((st) => ({ code: st.code, attic: !!st.attic, fields: st.fields.map((f) => ({ v: f.v, min: f.min, max: f.max, raw: !!f.raw, unit: f.unit ?? 'cm' })), cam: st.cam, dims: st.dims, boxes: st.boxes || [], hl: st.hl || [], valText: valText(st) }));
    out.measureApply = steps.map((_, i) => {
      state = clone(saved);
      const st = walkSteps()[i];
      const inputs = st.fields.map((f) => { const shown = f.raw ? Math.round(f.v) : +(f.v * 100).toFixed(1); return Math.min(f.max, Math.max(f.min, shown + (f.raw ? 1 : 3.3))); });
      st.fields.forEach((f, k) => f.set(f.raw ? inputs[k] : inputs[k] / 100));
      if (st.attic) state.options.attic = atticOf(state.options.attic);
      return { code: st.code, inputs, below: clone(state.options.below), gable: clone(state.options.gable), attic: clone(state.options.attic) };
    });
    state = clone(saved);
    return deep(out);
  };

  // sanitize alone, on a corpus of odd inputs; ids v41 made up become '<new>'
  window.__goldSanitize = (list) => list.map((p) => {
    const ids = new Set((p && Array.isArray(p.items) ? p.items : []).map((i) => i && i.id).filter((x) => typeof x === 'string'));
    const s = sanitize(clone(p));
    if (!s) return null;
    s.items.forEach((i) => { if (!ids.has(i.id)) i.id = '<new>'; });
    return deep(s);
  });
  window.__goldReady = true;
}
