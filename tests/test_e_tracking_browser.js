/* Test E – calmer tracking in the live scanner: old tracker (v1, 20 Nov) vs new tracker (v2, 21 Nov) on the SAME
 * synthetic camera scene. No camera in the browser pane → a canvas plays the camera:
 *   - product A (a real package photo) moves on a smooth path (≈ 300 px/s), and is covered completely by a "hand"
 *     between 3.2 s and 3.9 s (0.7 s),
 *   - product B stands still on the right,
 *   - at 1.5 s product A gets a name (as if a barcode had been read), so we can see whether the name survives.
 * The real scanner pipeline runs on that canvas (YOLOE detector, tracker, drawing; OCR/own model in the background).
 * Every 33 ms the boxes the user would SEE are sampled and compared with the true position of A.
 *
 * Setup: the old live.js is served temporarily as /js/_live_v1.js (copied from archiv/stand-2026-11-21-vor-erkennung,
 *        plus a 4-line startSource like the new one); photos from public/_s2test/ (not in the repo).
 * Run:   open http://localhost:8543/#/live, paste this file into the console, then  await runE()
 * Result: { v1: metrics, v2: metrics } – see EVALUATION.md "S4 – E".
 */
window.runE = async (photoA = "_s2test/5449000321794.jpg", photoB = "_s2test/3017620425035.jpg", seconds = 9) => {
  const load = async (u) => createImageBitmap(await (await fetch(u)).blob());
  const [A, B] = await Promise.all([load(photoA), load(photoB)]);
  const W = 1280, H = 720, AW = 230, AH = 330;
  const truthA = (t) => ({ cx: 420 + 300 * Math.sin(0.9 * t), cy: 360 + 50 * Math.sin(1.7 * t) });
  const occluded = (t) => t >= 3.2 && t < 3.9;

  async function run(modUrl) {
    const mod = await import(modUrl + "?v=" + Date.now());
    const main = document.querySelector("main") || document.body;
    await mod.renderLive(main);
    const c = document.createElement("canvas"); c.width = W; c.height = H; c.videoWidth = W; c.videoHeight = H;
    const x = c.getContext("2d");
    const t0 = performance.now(), T = () => (performance.now() - t0) / 1000;
    function paint() {
      const t = T();
      const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, "#3a3530"); g.addColorStop(1, "#6b625a");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.fillStyle = "#8a7f74"; x.fillRect(0, 560, W, 160); // table
      x.drawImage(B, 930, 230, 220, 320);
      const a = truthA(t); x.drawImage(A, a.cx - AW / 2, a.cy - AH / 2, AW, AH);
      if (occluded(t)) { x.fillStyle = "#d9a27a"; x.beginPath(); x.ellipse(a.cx, a.cy, AW * 0.75, AH * 0.68, 0.2, 0, 7); x.fill(); }
    }
    paint();
    const paintTimer = setInterval(paint, 16);
    const S = await mod.startSource(c);
    const samples = []; let named = false;
    await new Promise((done) => {
      const iv = setInterval(() => {
        const t = T(), a = truthA(t);
        const tracks = (S.view ? S.view(performance.now()) : S.tracks).filter((k) => !k.textOnly);
        // the track the user sees on A = the one whose centre is closest to A (within half a box)
        const near = tracks.map((k) => [k, Math.hypot((k.x1 + k.x2) / 2 - a.cx, (k.y1 + k.y2) / 2 - a.cy)]).filter(([, d]) => d < AW * 0.6).sort((p, q) => p[1] - q[1])[0];
        if (!named && t >= 1.5 && near) { near[0].label = { brand: "Product A", product: "", engine: "barcode" }; named = true; }
        samples.push({ t, occ: occluded(t), id: near?.[0].id ?? null, label: near?.[0].label?.brand ?? null,
          cx: near ? (near[0].x1 + near[0].x2) / 2 : null, cy: near ? (near[0].y1 + near[0].y2) / 2 : null, tx: a.cx, ty: a.cy });
        if (t > seconds) { clearInterval(iv); done(); }
      }, 33);
    });
    clearInterval(paintTimer); S.running = false;
    // ---- metrics
    const vis = samples.filter((s) => s.cx != null && s.t > 0.8);
    const after = samples.filter((s) => s.t >= 4.2);
    const ids = new Set(samples.filter((s) => s.id != null && s.t > 0.8).map((s) => s.id));
    // smoothness: frame-to-frame change of the box's deviation from the true path (pure jitter, motion removed)
    let jit = 0, n = 0;
    for (let i = 1; i < vis.length; i++) {
      const d0 = [vis[i - 1].cx - vis[i - 1].tx, vis[i - 1].cy - vis[i - 1].ty], d1 = [vis[i].cx - vis[i].tx, vis[i].cy - vis[i].ty];
      if (vis[i].t - vis[i - 1].t < 0.1) { jit += Math.hypot(d1[0] - d0[0], d1[1] - d0[1]) ** 2; n++; }
    }
    return {
      samples: samples.length,
      shown_outside_occlusion: +(samples.filter((s) => !s.occ && s.t > 0.8 && s.cx != null).length / samples.filter((s) => !s.occ && s.t > 0.8).length).toFixed(3),
      shown_during_occlusion: +(samples.filter((s) => s.occ && s.cx != null).length / Math.max(1, samples.filter((s) => s.occ).length)).toFixed(3),
      ids_on_A: ids.size,
      name_after_occlusion: +(after.filter((s) => s.label === "Product A").length / Math.max(1, after.length)).toFixed(3),
      mean_error_px: +(vis.reduce((s, v) => s + Math.hypot(v.cx - v.tx, v.cy - v.ty), 0) / Math.max(1, vis.length)).toFixed(1),
      jitter_rms_px: +Math.sqrt(jit / Math.max(1, n)).toFixed(2),
    };
  }
  const v1 = await run("/js/_live_v1.js");
  const v2 = await run("/js/live.js");
  window.__E = { v1, v2 };
  return { v1, v2 };
};
