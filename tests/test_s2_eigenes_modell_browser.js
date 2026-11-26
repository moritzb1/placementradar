/* Test S2 Teil 2 – own brand model (stage 4) IN THE BROWSER, together with OCR (stage 3), on the same 49 photos.
 *
 * Setup as in test_s2_ocr_browser.js (photos in public/_s2test/, not in the repo).
 * Open http://localhost:8540/#/live (loads ONNX Runtime), paste this file into the console, then: await runS2b()
 * For every photo and variant (original / webcam): OCR on the whole photo; the own model on the whole photo.
 * Cascade like the app (live.js RANK): brand read EXACTLY > own model (if "sure") > brand read with a typo.
 * Also checks that the browser model matches Python (per-photo predictions in tests/ergebnisse/s2_live/).
 */
window.runS2b = async () => {
  const m = await import('/js/ocr.js?v=' + Date.now()); await m.loadOcr(); await m.loadBrands();
  const bm = await import('/js/brandmodel.js?v=' + Date.now()); await bm.loadBrandModel();
  const idx = await (await fetch('_s2test/index.json')).json(); const by = Object.fromEntries(idx.map(e => [e.code, e]));
  const files = await (await fetch('_s2test/files.json')).json(); // the 49 photo codes (tests/galerie_off/anfragen)
  const FAMILY = { sprite: 'cocacola', cocacola: 'cocacola', actimel: 'danone', danone: 'danone', fruchtzwerge: 'danone', ferrero: 'nutella', nutella: 'nutella', rewe: 'rewebestewahl', kinder: 'ferrero', froop: 'muller', muller: 'muller', mullermilch: 'muller' }; // product lines of the same company count as right (21 Nov: Fruchtzwerge, Froop)
  const out = [];
  // createImageBitmap instead of img.decode(): also works while the browser tab is in the background
  async function load(name) { const img = await createImageBitmap(await (await fetch('_s2test/' + name + '.jpg')).blob()); img.naturalWidth = img.width; img.naturalHeight = img.height; const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }
  function degrade(c) { const s = 640 / Math.max(c.width, c.height); const d = document.createElement('canvas'); d.width = Math.round(c.width * s); d.height = Math.round(c.height * s); const x = d.getContext('2d'); x.filter = 'blur(1px)'; x.drawImage(c, 0, 0, d.width, d.height); return new Promise(r => d.toBlob(async b => { const i = await createImageBitmap(b); const e = document.createElement('canvas'); e.width = d.width; e.height = d.height; e.getContext('2d').drawImage(i, 0, 0); r(e); }, 'image/jpeg', 0.6)); }
  for (const code of files) {
    const e = by[code]; const truth = (e.brands || '').split(',').map(s => m.brandKey(s)).filter(Boolean).concat([m.brandKey(e.marke)]);
    const fam = new Set(truth.map(t => FAMILY[t] || t)); const okKey = k => truth.includes(k) || fam.has(FAMILY[k] || k);
    for (const variant of ['original', 'webcam']) {
      let c = await load(code); if (variant === 'webcam') c = await degrade(c);
      const br = m.matchBrands(await m.readText(c, c.width, c.height));
      window.__s2prog = (window.__s2prog || 0) + 1;
      const own = await bm.classifyBox(c, { x1: 0, y1: 0, x2: c.width, y2: c.height }, c.width, c.height);
      const ownKey = m.brandKey(own.brand);
      const ocrOk = br.some(b => okKey(b.key)), ocrWrong = br.filter(b => !okKey(b.key)).map(b => b.brand);
      const exact = br.filter(b => b.exact), fuzzy = br.filter(b => !b.exact);
      const ownUsed = !exact.length && own.sure;
      // what the app finally shows: exact text brands, else the own model, else the fuzzy text brands
      const shown = exact.length ? exact.map(b => b.key) : ownUsed ? [ownKey] : fuzzy.map(b => b.key);
      out.push({ code, variant, truth: e.brands, ocr: br.map(b => b.brand), own: own.brand, ownConf: +own.conf.toFixed(3), ownSure: own.sure, ownMs: own.ms,
        ownOk: okKey(ownKey), ocrOk, ocrWrong, cascadeOk: shown.some(okKey), cascadeWrong: shown.some(k => !okKey(k)), shown });
    }
  }
  window.__s2b = out;
  const sum = v => { const r = out.filter(o => o.variant === v); return { n: r.length,
    ocrOnly: r.filter(o => o.ocrOk).length, ownSureRight: r.filter(o => o.ownSure && o.ownOk).length, ownSureWrong: r.filter(o => o.ownSure && !o.ownOk).length,
    cascadeRight: r.filter(o => o.cascadeOk).length, cascadeWrong: r.filter(o => o.cascadeWrong).length,
    ownMedMs: r.map(o => o.ownMs).sort((a, b) => a - b)[r.length >> 1] }; };
  return { original: sum('original'), webcam: sum('webcam'),
    addedByOwn: out.filter(o => !o.ocrOk && o.cascadeOk).map(o => `${o.variant} ${o.code} ${o.own}`),
    lostByOwn: out.filter(o => o.ocrOk && !o.cascadeOk).map(o => `${o.variant} ${o.code} ocr=${o.ocr} own=${o.own}`),
    cascadeWrongList: out.filter(o => o.cascadeWrong).map(o => `${o.variant} ${o.code} shown=${o.shown} truth=${o.truth}`),
    wrongByOwn: out.filter(o => !o.ocr.length && o.ownSure && !o.ownOk).map(o => `${o.variant} ${o.code} ${o.own} (truth ${o.truth})`) };
};
