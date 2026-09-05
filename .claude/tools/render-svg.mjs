#!/usr/bin/env node
/**
 * render-svg — rasterize an SVG file to PNG with headless Edge/Chrome.
 *
 * Usage:  node render-svg.mjs <input.svg> <output.png> [scale]
 *
 * Exists so the `svg-maker` agent can LOOK at what it authored: the Read tool
 * can display a PNG but not an SVG, so verification requires a raster step.
 * Uses whichever Chromium-family browser is installed (no npm deps, no
 * puppeteer download).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , inSvg, outPng, scaleArg] = process.argv;
if (!inSvg || !outPng) {
  console.error("usage: node render-svg.mjs <input.svg> <output.png> [scale]");
  process.exit(2);
}
const scale = Number(scaleArg || 2);

const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  process.env.CHROME_PATH,
].filter(Boolean);
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error("no Chromium-family browser found; set CHROME_PATH");
  process.exit(1);
}

const svg = fs.readFileSync(path.resolve(inSvg), "utf8");

// Prefer explicit width/height; fall back to the viewBox extents; then a default.
function dims(src) {
  const w = /<svg[^>]*\bwidth="([\d.]+)/.exec(src);
  const h = /<svg[^>]*\bheight="([\d.]+)/.exec(src);
  if (w && h) return [Math.ceil(+w[1]), Math.ceil(+h[1])];
  const vb = /viewBox="\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(src);
  if (vb) return [Math.ceil(+vb[3]), Math.ceil(+vb[4])];
  return [800, 600];
}
const [width, height] = dims(svg);

// Wrap in a zero-margin page so the screenshot is exactly the drawing.
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style>
${svg}`;

const tmp = path.join(os.tmpdir(), `render-svg-${process.pid}-${Date.now()}.html`);
fs.writeFileSync(tmp, html, "utf8");

const out = path.resolve(outPng);
fs.mkdirSync(path.dirname(out), { recursive: true });

try {
  execFileSync(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=" + scale,
      `--window-size=${width},${height}`,
      `--screenshot=${out}`,
      "file:///" + tmp.replace(/\\/g, "/"),
    ],
    { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  );
} catch (e) {
  console.error("browser render failed:", e.stderr?.toString().slice(0, 500) || e.message);
  process.exit(1);
} finally {
  try { fs.unlinkSync(tmp); } catch {}
}

if (!fs.existsSync(out)) {
  console.error("render produced no file");
  process.exit(1);
}
console.log(`OK ${out} (${width}x${height} @${scale}x)`);
