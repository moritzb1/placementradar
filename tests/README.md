# Tests

Every script behind [EVALUATION.md](../EVALUATION.md); the letter in brackets below is the test there. Notes inside the scripts and
the `LIESMICH.md` files are partly in German.

| Needs | Scripts |
|---|---|
| **nothing** – re-run on stored results, no network, no quota | `test_wahrheit.mjs` (M1–M2, M5), `test_stabilitaet.mjs` (M4), `test_w_filter.mjs` (W2), `test_e_tracker_sim.mjs` (T) |
| network, no key | `test_sponsorblock.mjs` (M3), `test_k_kommentare.mjs` (K) |
| a local Worker (`npx wrangler dev`, key in `.dev.vars`) | `test_e2_kanal.mjs` (E2), `test_e3_creators.mjs` (E3), `test_e4_assess.mjs` (E4), `test_g_agent.mjs` (G) |
| a Gemini key (`GEMINI_API_KEY` in the shell or `../.dev.vars`) | `test_a_…py`, `test_b2_…py`, `test_d_…py`, `test_e_positionen_…py`, `test_i_…py` |
| Chrome + puppeteer-core, the app on `localhost:8540` | `test_v_verify.mjs` (V), `test_e_tracking_browser.js`, `test_s2_*_browser.js` (S2) |
| photos that are **not** in the repository | `test_echt.py`, `test_h*.py`, `test_s2_*` (product photos), `markieren/` (video frames for the marking page) |

Folders: `ergebnisse/` raw answers, streams and numbers of every run · `wahrheit/` the hand-marked ground truth of test M
(proposed by Claude, checked frame by frame by Moritz on 25 Nov; `*.vorher.json` = before the check) · `kommentare/` hand labels
for test K · `markieren/` the local marking page · `galerie_off/` the list of Open Food Facts products used in S2.

Photos and video frames are left out on purpose: some are our own photos, the rest are large and can be fetched again
(Open Food Facts, YouTube thumbnails). Browser tests are always run muted (`--mute-audio`, player muted before playing).
