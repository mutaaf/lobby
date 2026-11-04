// Fonts for the frames: Google Fonts families are fetched once as TTF into ~/.cache/lobby/fonts
// (headless Chrome then renders offline and byte-stable); a manifest can also point at local files.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE, mkdirp } from "./util.mjs";

const DIR = mkdirp(join(CACHE, "fonts"));

/** spec: { family, weights?: [..], file?: path, files?: {weight: path} } → @font-face CSS (file:// URLs). */
export async function fontFaces(spec, alias, appDir) {
  if (!spec) return "";
  if (typeof spec === "string") spec = { family: spec };
  const weights = spec.weights ?? [400, 700];
  if (spec.files || spec.file) {
    const files = spec.files ?? Object.fromEntries(weights.map((w) => [w, spec.file]));
    return Object.entries(files).map(([w, f]) => `@font-face{font-family:'${alias}';font-weight:${w};src:url('file://${resolve(appDir, f)}')}`).join("\n");
  }
  const key = `${spec.family.replace(/\W+/g, "_")}-${weights.join("_")}`;
  const cssFile = join(DIR, `${key}.css`);
  if (!existsSync(cssFile)) {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(spec.family)}:wght@${weights.join(";")}&display=block`;
    // A non-browser user agent gets plain TTF URLs (one file per weight), which is what we want to cache.
    const r = await fetch(url, { headers: { "user-agent": "lobby/1" } });
    if (!r.ok) throw new Error(`Google Fonts has no "${spec.family}" with weights ${weights.join(",")} (${r.status}). Fix brand fonts in store/lobby.json.`);
    let css = await r.text();
    const urls = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
    for (const u of urls) {
      const f = join(DIR, `${key}-${urls.indexOf(u)}.ttf`);
      if (!existsSync(f)) writeFileSync(f, Buffer.from(await (await fetch(u)).arrayBuffer()));
      css = css.replace(u, `file://${f}`);
    }
    writeFileSync(cssFile, css);
  }
  return readFileSync(cssFile, "utf8").replace(/font-family:\s*'[^']+'/g, `font-family:'${alias}'`);
}
