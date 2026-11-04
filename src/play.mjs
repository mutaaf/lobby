// Google Play: images through the Android Publisher API (edits → upload → commit), signed with a
// service account at ~/.config/lobby/play-service-account.json. Without that file (or without a Play
// app for the package) Lobby stages the assets in store/lobby/out/play and says so; it never creates
// a Play account, app or service account (those cost money or need the owner).
import { createSign } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, SPECS } from "./util.mjs";

const KEY = join(CONFIG, "play-service-account.json");
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UP = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

async function token() {
  const k = JSON.parse(readFileSync(KEY, "utf8")), now = Math.floor(Date.now() / 1000), b = (x) => Buffer.from(x).toString("base64url");
  const h = b(JSON.stringify({ alg: "RS256", typ: "JWT" })), p = b(JSON.stringify({ iss: k.client_email, scope: "https://www.googleapis.com/auth/androidpublisher", aud: k.token_uri, iat: now, exp: now + 3600 }));
  const jwt = `${h}.${p}.${createSign("RSA-SHA256").update(`${h}.${p}`).sign(k.private_key).toString("base64url")}`;
  const r = await fetch(k.token_uri, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  if (!r.ok) throw new Error(`Play token → ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

export const playReady = () => existsSync(KEY);

export async function pushPlay(app, report, { dryRun = false, log = console.log } = {}) {
  const pkg = app.m.android?.package;
  if (!pkg) return log("  play: no android.package in manifest; assets staged in out/play");
  if (!playReady()) return log(`  play: no service account (${KEY}); assets staged in out/play for upload`), { staged: true };
  const t = await token(), H = { authorization: `Bearer ${t}` }, lang = app.m.locale ?? "en-US";
  const j = async (method, url, body) => { const r = await fetch(url, { method, headers: { ...H, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const x = await r.text(); if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${x}`); return x ? JSON.parse(x) : {}; };
  let edit;
  try { edit = await j("POST", `${API}/${pkg}/edits`); } catch (e) { return log(`  play: ${pkg} isn't reachable with this service account (${e.message.slice(0, 120)}); staged`), { staged: true }; }
  for (const e of report.filter((x) => x.store === "play" && x.files.length)) {
    const type = SPECS.play.targets[e.target].playType;
    if (dryRun) { log(`  play/${e.target}: would upload ${e.files.length} as ${type}`); continue; }
    await j("DELETE", `${API}/${pkg}/edits/${edit.id}/listings/${lang}/${type}`);
    for (const f of e.files) {
      const r = await fetch(`${UP}/${pkg}/edits/${edit.id}/listings/${lang}/${type}?uploadType=media`, { method: "POST", headers: { ...H, "content-type": "image/png" }, body: readFileSync(f) });
      if (!r.ok) throw new Error(`play upload ${f} → ${r.status} ${await r.text()}`);
    }
    log(`  ✓ play/${e.target}: ${e.files.length} uploaded (${type})`);
  }
  if (dryRun) return j("DELETE", `${API}/${pkg}/edits/${edit.id}`);
  await j("POST", `${API}/${pkg}/edits/${edit.id}:commit`);
  log("  ✓ play: edit committed");
  return { pushed: true };
}
