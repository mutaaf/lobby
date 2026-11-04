// Small shared helpers: no dependencies.
import { readFileSync, existsSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export const LOBBY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = process.env.HOME;
export const PROJECTS = process.env.LOBBY_PROJECTS ?? join(HOME, "Desktop", "projects");
export const CACHE = join(HOME, ".cache", "lobby");
export const CONFIG = join(HOME, ".config", "lobby");
export const CHROME = process.env.LOBBY_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const SPECS = JSON.parse(readFileSync(join(LOBBY, "specs", "stores.json"), "utf8")).stores;

export const mkdirp = (d) => (mkdirSync(d, { recursive: true }), d);
export const md5 = (buf) => createHash("md5").update(buf).digest("hex");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Width/height of a PNG or JPEG without decoding it. */
export function imageSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 || b[25] === 4 };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), alpha: false };
      i += 2 + len;
    }
  }
  throw new Error(`${file}: not a PNG or JPEG`);
}

export function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, stdout, stderr) =>
    err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr })));
}

/** Run async jobs with at most `n` in flight. */
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Deterministic RNG so a re-render of the same manifest is byte-stable (idempotent uploads). */
export function rng(seed) {
  let a = 0; for (const c of String(seed)) a = (Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0);
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export const esc = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Caption markup: *word* = accent colour, _word_ = highlighter swipe, | = line break. */
export const markup = (s = "") => esc(s).replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/(^|[\s(])_([^_]+)_/g, "$1<u>$2</u>").replace(/\s*\|\s*/g, "<br>");
export const plain = (s = "") => String(s).replace(/[*_|]/g, "");

export function readJSON(f) { return JSON.parse(readFileSync(f, "utf8")); }
export function listPNG(dir) { return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort() : []; }
export const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

/** Hex → [r,g,b]; relative luminance; mix. */
export const rgb = (h) => { const x = h.replace("#", ""); const v = x.length === 3 ? x.split("").map((c) => c + c).join("") : x; return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)); };
export const lum = (h) => { const [r, g, b] = rgb(h).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export const alpha = (h, a) => `rgba(${rgb(h).join(",")},${a})`;
