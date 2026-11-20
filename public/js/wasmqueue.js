/**
 * wasmqueue.js — ONNX Runtime's WASM backend can run only ONE model at a time ("Session already started").
 * OCR (two models) and the own brand model both use WASM and may be triggered at the same moment in camera mode,
 * so every WASM inference goes through this queue. The detector runs on WebGPU and is not queued (keeps video smooth).
 */
let tail = Promise.resolve();
export function runWasm(session, feeds) {
  const job = tail.then(() => session.run(feeds));
  tail = job.catch(() => {}); // a failed run must not block the queue
  return job;
}
