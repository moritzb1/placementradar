// story_pdf.mjs – print docs/story/index.html to a PDF (one 1920 × 1080 page per slide) and, with --png, one PNG per slide.
// Run: PUPPETEER=<path>/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js node tools/story_pdf.mjs [--png]
// Chrome is started muted (project rule) and headless; the page needs the Inter web font, so it waits for document.fonts.
import path from "path"; import fs from "fs"; import { fileURLToPath } from "url";
const puppeteer = (await import(process.env.PUPPETEER || "puppeteer-core")).default;
const STORY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "story");
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--mute-audio", "--allow-file-access-from-files"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
await page.goto("file://" + path.join(STORY, "index.html"), { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await page.pdf({ path: path.join(STORY, "PlacementRadar_slides.pdf"), width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
if (process.argv.includes("--png")) {
  await page.emulateMediaType("print"); // same layout as the PDF pages
  const out = path.join(STORY, "png");
  fs.mkdirSync(out, { recursive: true });
  const slides = await page.$$(".slide");
  for (let i = 0; i < slides.length; i++) await slides[i].screenshot({ path: path.join(out, `slide${String(i + 1).padStart(2, "0")}.png`) });
}
await browser.close();
console.log("written", path.join(STORY, "PlacementRadar_slides.pdf"));
