// Lint: everything a store console or App Review would bounce, caught before upload.
// Errors block push; warnings are reported (the agent fixes them on its next pass).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPECS, imageSize, listPNG, plain, contrast } from "./util.mjs";
import { duration } from "./preview.mjs";

// Claims no listing may make without proof we don't have (Apple 2.3.7 / Play metadata policy).
const CLAIMS = [/#\s?1\b/i, /\bnumber one\b/i, /\bbest\b/i, /\btop[- ]rated\b/i, /\baward/i, /\bmillions?\b/i, /\b\d+[kKmM]\+? (users|players|downloads|families)\b/i,
  /★|⭐|\b\d(\.\d)? stars?\b/i, /\bfree forever\b/i, /\bguaranteed?\b/i, /\bofficial\b/i];
// A frame can't name the other store's platform (Apple 2.3.10, Play metadata policy).
const NOT_ON_APPLE = [/\bandroid\b/i, /\bgoogle play\b/i, /\bplay store\b/i];
const NOT_ON_ANDROID = [/\bapple(?! tv)\b/i, /\biphone\b/i, /\bipad\b/i, /\bapp store\b/i, /\bsiri\b/i, /\bios\b/i];
// Extra rules for anything a child sees (same spirit as the kids rules in Marquee/Playbill).
const KIDS = [/\bbuy\b/i, /\bpurchase\b/i, /\bsubscribe\b/i, /\bdownload now\b/i, /\bclick\b/i, /\btap here\b/i, /\bwin money\b/i, /\bcash\b/i, /https?:\/\//i];

export async function lint(app, report = null) {
  const m = app.m, errors = [], warns = [];
  const err = (s) => errors.push(s), warn = (s) => warns.push(s);

  // Manifest
  for (const k of ["slug", "name", "brand", "shots", "stores"]) if (!m[k]) err(`store/lobby.json: missing "${k}"`);
  if (m.brand) {
    for (const k of ["bg", "ink", "accent"]) if (!m.brand[k]) err(`brand.${k} is required`);
    if (m.brand.bg && m.brand.ink && contrast(m.brand.bg, m.brand.ink) < 4.5) err(`brand ink on bg contrast ${contrast(m.brand.bg, m.brand.ink).toFixed(1)}:1 (needs ≥ 4.5)`);
    if (m.brand.bg && m.brand.accent && contrast(m.brand.bg, m.brand.accent) < 2.2) warn(`brand accent on bg contrast ${contrast(m.brand.bg, m.brand.accent).toFixed(1)}:1: emphasised words may wash out`);
  }
  const shots = m.shots ?? [];
  if (shots.length < 3) err(`${shots.length} shots: stores show 3 in search results, so plan at least 3 (5–8 is best)`);
  const ids = new Set();
  shots.forEach((s, i) => {
    const where = `shot ${i + 1} (${s.id ?? s.raw})`;
    if (!s.raw) err(`${where}: no "raw" capture id`);
    if (ids.has(s.id ?? s.raw)) err(`${where}: duplicate id`); ids.add(s.id ?? s.raw);
    if (!s.title) err(`${where}: no title`);
    const t = plain(s.title ?? "");
    if (t.length > 44) warn(`${where}: title is ${t.length} chars; ≤ 32 reads at thumbnail size, 44 is the ceiling`);
    if (plain(s.sub ?? "").length > 110) warn(`${where}: sub is ${plain(s.sub).length} chars (≤ 110)`);
    if (plain(s.badge ?? "").length > 18) warn(`${where}: badge "${s.badge}" is long for a sticker (≤ 18)`);
    if (s.focus && (s.focus.length !== 3 || s.focus.some((v) => v < 0 || v > 1))) err(`${where}: focus must be [cx, cy, width] fractions`);
    const text = [s.kicker, s.title, s.sub, s.badge].filter(Boolean).map(plain).join(" ");
    for (const re of CLAIMS) if (re.test(text)) err(`${where}: "${text.match(re)[0]}" is a claim stores reject (ranking, ratings, counts, platform names)`);
    const on = s.stores ?? m.stores ?? [];
    if (on.includes("appstore")) for (const re of NOT_ON_APPLE) if (re.test(text)) err(`${where}: "${text.match(re)[0]}" can't appear in App Store frames`);
    if (on.some((x) => ["play", "amazon", "galaxy"].includes(x))) for (const re of NOT_ON_ANDROID) if (re.test(text)) err(`${where}: "${text.match(re)[0]}" can't appear in Android-store frames (limit the shot with "stores")`);
    if (m.audience === "kids") for (const re of KIDS) if (re.test(text)) err(`${where}: "${text.match(re)[0]}" isn't allowed in a kids app's frames`);
    for (const w of m.avoid ?? []) if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) err(`${where}: "${w}" is on this app's avoid list (trademark / IP)`);
  });
  // The first three are the search-result card: each needs a capture on the main source.
  shots.slice(0, 3).forEach((s, i) => { if (s.raw && !app.raw.iphone.some((r) => r.id.startsWith(s.raw) || r.id.includes(s.raw))) warn(`shot ${i + 1} (${s.raw}) has no iPhone capture: the search card will show a later shot`); });
  if (m.icon && !existsSync(join(app.dir, m.icon))) err(`icon ${m.icon} not found`);
  if (m.icon && existsSync(join(app.dir, m.icon))) { const { w, h } = imageSize(join(app.dir, m.icon)); if (w < 1024 || h < 1024 || w !== h) err(`icon is ${w}×${h}; needs a square ≥ 1024`); }
  for (const raw of app.raw.iphone) if (raw.h / raw.w < 1.8) warn(`raw/iphone/${raw.id} is ${raw.w}×${raw.h}: not a phone capture`);

  // Rendered output
  if (report) {
    for (const e of report) {
      const t = SPECS[e.store].targets[e.target];
      const req = t.required === true || (t.required === "ipad" && m.ipad);
      for (const s of e.skipped) warn(`${e.store}/${e.target}: skipped ${s}`);
      if (t.kind === "screenshot") {
        if (req && e.files.length < (t.min ?? 1)) err(`${e.store}/${e.target}: ${e.files.length} screenshots (needs ≥ ${t.min ?? 1})`);
        if (e.files.length > (t.max ?? 10)) err(`${e.store}/${e.target}: ${e.files.length} screenshots (max ${t.max})`);
      }
      for (const f of e.files) {
        const { w, h } = imageSize(f);
        if (w !== t.w || h !== t.h) err(`${f}: ${w}×${h}, ${e.store}/${e.target} needs ${t.w}×${t.h}`);
      }
    }
    for (const e of report.filter((x) => SPECS[x.store].targets[x.target].kind === "preview")) {
      const mp4 = join(app.out, e.store, `${e.target}.mp4`);
      if (!existsSync(mp4)) continue;
      const t = SPECS[e.store].targets[e.target], d = await duration(mp4);
      if (d < t.minSec || d > t.maxSec) err(`${mp4}: ${d.toFixed(1)} s (needs ${t.minSec}–${t.maxSec})`);
    }
  }
  return { errors, warns };
}
