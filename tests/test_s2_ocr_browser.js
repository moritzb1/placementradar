/* Test S2 – on-device OCR brand recognition, run IN THE BROWSER (same code as the app).
 *
 * Setup: copy the test photos next to the app (they are NOT part of the repo):
 *   mkdir -p public/_s2test && cp tests/galerie_off/anfragen/*.jpg tests/galerie_off/index.json public/_s2test/
 * Start the local preview (port 8540), open http://localhost:8540/#/live, paste this file into the console,
 * then: await runS2()   → summary; window.__s2res holds one row per photo and variant.
 *
 * Photos: 49 original phone photos of Open Food Facts products (uncropped, hand/shelf/background), ground truth
 * = the product's brands in Open Food Facts. Variant "webcam": scaled to 640 px, 1 px blur, JPEG 0.6.
 * Scores: exact = a found brand equals one of the product's brands; family = also counts product brand ↔ owner
 * (Sprite ↔ Coca-Cola, Actimel ↔ Danone, Ferrero ↔ Nutella, REWE ↔ REWE Beste Wahl).
 */
window.runS2 = async () => {
  const m = await import('/js/ocr.js?v=' + Date.now()); await m.loadOcr(); await m.loadBrands();
  const idx = await (await fetch('_s2test/index.json')).json(); const by = Object.fromEntries(idx.map(e => [e.code, e]));
  const files = ['20692285','7622210704740','4009700035745','4056489206217','5449000321794','4008452028135','5010029227062','4001686011225','4002971253207','4001954000494','84100733','4001954000456','5411188125808','8000500131329','8000500227848','4250793501703','4008452036130','4008400191423','40255101','40084053','4056489118190','7622300744663','7622300444181','7622210616241','4311501012246','7622210306449','3017620425035','8000500392935','80946458','3033491454080','4337256199612','4260301527101','3073781106497','5000112639445','5415049001201','4337256679978','7622210038067','90311161','3073780855358','90398087','4311501050224','4311501695135','4337256760485','42448877','4056489187813','8934680033428','7622210585639','4000412020203','4008452028111'];
  const FAMILY = { sprite: 'cocacola', cocacola: 'cocacola', actimel: 'danone', danone: 'danone', ferrero: 'nutella', nutella: 'nutella', rewe: 'rewebestewahl', kinder: 'ferrero' };
  const out = [];
  async function load(name) { const img = new Image(); img.src = '_s2test/' + name + '.jpg'; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); return c; }
  function degrade(c) { const s = 640 / Math.max(c.width, c.height); const d = document.createElement('canvas'); d.width = Math.round(c.width * s); d.height = Math.round(c.height * s); const x = d.getContext('2d'); x.filter = 'blur(1px)'; x.drawImage(c, 0, 0, d.width, d.height); return new Promise(r => d.toBlob(async b => { const i = new Image(); i.src = URL.createObjectURL(b); await i.decode(); const e = document.createElement('canvas'); e.width = d.width; e.height = d.height; e.getContext('2d').drawImage(i, 0, 0); r(e); }, 'image/jpeg', 0.6)); }
  for (const code of files) {
    const e = by[code]; const truth = (e.brands || '').split(',').map(s => m.brandKey(s)).filter(Boolean).concat([m.brandKey(e.marke)]);
    const fam = new Set(truth.map(t => FAMILY[t] || t));
    for (const variant of ['original', 'webcam']) {
      let c = await load(code); if (variant === 'webcam') c = await degrade(c);
      const words = await m.readText(c, c.width, c.height); const br = m.matchBrands(words);
      const ok = b => truth.includes(b.key), okFam = b => ok(b) || fam.has(FAMILY[b.key] || b.key);
      out.push({ code, variant, truth: e.brands, found: br.map(b => b.brand), read: br.map(b => b.read), ms: words.ms, words: words.length,
        any_correct: br.some(ok), any_family: br.some(okFam), wrong: br.filter(b => !okFam(b)).map(b => b.brand) });
    }
  }
  window.__s2res = out;
  const sum = v => { const r = out.filter(o => o.variant === v); return { n: r.length, exact: r.filter(o => o.any_correct).length, family: r.filter(o => o.any_family).length, none: r.filter(o => !o.found.length).length, falseBrands: r.reduce((s, o) => s + o.wrong.length, 0), medMs: r.map(o => o.ms).sort((a, b) => a - b)[r.length >> 1] }; };
  return { original: sum('original'), webcam: sum('webcam'), wrong: out.filter(o => o.wrong.length).map(o => `${o.variant} ${o.code} ${o.wrong} ← ${o.read.join('/')}`) };
};
