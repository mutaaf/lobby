// App Store Connect: one client for every app on the team key. Reads the key from
// ~/.config/lobby/asc.env (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH); falls back to an app's own
// .env.testflight / .local/asc.env. Never prints the key. Never submits for review.
import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG, SPECS, md5, sleep, imageSize } from "./util.mjs";

const API = "https://api.appstoreconnect.apple.com";
// Only these states take new screenshots/previews. WAITING_FOR_REVIEW / IN_REVIEW / READY_FOR_SALE are locked:
// Lobby stages the assets and pushes them when the next version opens.
export const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);

function readEnv(f) {
  const out = {};
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "").replace(/^\$HOME|^~/, process.env.HOME);
  }
  return out;
}

export function ascEnv(appDir) {
  const tries = [join(CONFIG, "asc.env"), appDir && join(appDir, ".env.testflight"), appDir && join(appDir, ".local", "asc.env")].filter(Boolean);
  for (const f of tries) {
    if (!existsSync(f)) continue;
    const e = readEnv(f);
    const id = e.ASC_KEY_ID ?? e.ASC_API_KEY_ID, iss = e.ASC_ISSUER_ID ?? e.ASC_API_ISSUER_ID, p = e.ASC_KEY_PATH ?? e.ASC_API_KEY_PATH;
    if (id && iss && p && existsSync(p)) return { id, iss, path: p, from: f };
  }
  return null;
}

export function client(appDir) {
  const k = ascEnv(appDir);
  if (!k) throw new Error("No App Store Connect key: put ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in ~/.config/lobby/asc.env");
  let cached;
  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - 60 > now) return cached.jwt;
    const b = (x) => Buffer.from(x).toString("base64url");
    const h = b(JSON.stringify({ alg: "ES256", kid: k.id, typ: "JWT" })), p = b(JSON.stringify({ iss: k.iss, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" }));
    const sig = createSign("SHA256").update(`${h}.${p}`).sign({ key: createPrivateKey(readFileSync(k.path)), dsaEncoding: "ieee-p1363" });
    cached = { jwt: `${h}.${p}.${b(sig)}`, exp: now + 1200 };
    return cached.jwt;
  };
  const api = async (method, path, body) => {
    const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(), json = text ? JSON.parse(text) : {};
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${(json.errors ?? []).map((x) => `${x.title}: ${x.detail}`).join("; ") || text}`), { status: r.status });
    return json;
  };
  return { api };
}

/** The app's newest App Store version + its en-US localization, and whether it can take assets now. */
export async function state(appDir, bundleId) {
  const { api } = client(appDir);
  const a = (await api("GET", `/v1/apps?filter[bundleId]=${bundleId}&limit=1`)).data[0];
  if (!a) return { exists: false };
  const vs = (await api("GET", `/v1/apps/${a.id}/appStoreVersions?filter[platform]=IOS&limit=5`)).data;
  const v = vs.find((x) => EDITABLE.has(x.attributes.appStoreState)) ?? vs[0];
  const st = v?.attributes.appStoreState;
  return { exists: true, appId: a.id, name: a.attributes.name, version: v?.attributes.versionString, versionId: v?.id, state: st, editable: EDITABLE.has(st), api };
}

async function uploadParts(ops, buf, label) {
  for (const op of ops) {
    const r = await fetch(op.url, { method: op.method, headers: Object.fromEntries(op.requestHeaders.map((h) => [h.name, h.value])), body: buf.subarray(op.offset, op.offset + op.length) });
    if (!r.ok) throw new Error(`upload ${label} part @${op.offset} → ${r.status}`);
  }
}

/** Push rendered screenshots + previews to the editable version. Idempotent (matching sets are left alone). */
export async function pushASC(app, report, { dryRun = false, log = console.log } = {}) {
  const bundleId = app.m.ios?.bundleId;
  if (!bundleId) return log("  appstore: no ios.bundleId in manifest; skipped");
  const s = await state(app.dir, bundleId);
  if (!s.exists) return log(`  appstore: no App Store Connect app for ${bundleId} yet (create it once in the web UI; Lobby never creates apps)`);
  if (!s.editable) return log(`  appstore: ${s.name} ${s.version} is ${s.state}: assets staged, pushed when a version is editable`), { staged: true, state: s.state };
  const { api } = s;
  const loc = (await api("GET", `/v1/appStoreVersions/${s.versionId}/appStoreVersionLocalizations`)).data.find((l) => l.attributes.locale === (app.m.locale ?? "en-US"));
  if (!loc) return log("  appstore: no en-US localization on the version yet; skipped");
  const sets = (await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`)).data;
  for (const e of report.filter((x) => x.store === "appstore")) {
    const t = SPECS.appstore.targets[e.target];
    if (t.kind === "screenshot" && e.files.length) {
      const local = e.files.map((f) => { const buf = readFileSync(f); return { f: basename(f), buf, md5: md5(buf) }; });
      let set = sets.find((x) => x.attributes.screenshotDisplayType === t.ascType);
      if (dryRun) { log(`  appstore/${e.target}: would upload ${local.length} to ${t.ascType}`); continue; }
      if (!set) set = (await api("POST", "/v1/appScreenshotSets", { data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: t.ascType }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
      const remote = (await api("GET", `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=10`)).data;
      const same = (r, l) => r.attributes.fileName === l.f && r.attributes.fileSize === l.buf.length && r.attributes.assetDeliveryState?.state !== "FAILED" && (r.attributes.sourceFileChecksum == null || r.attributes.sourceFileChecksum === l.md5);
      if (remote.length === local.length && remote.every((r, i) => same(r, local[i]))) { log(`  ✓ appstore/${e.target}: up to date`); continue; }
      for (const r of remote) await api("DELETE", `/v1/appScreenshots/${r.id}`);
      const ids = [];
      for (const l of local) {
        const shot = (await api("POST", "/v1/appScreenshots", { data: { type: "appScreenshots", attributes: { fileName: l.f, fileSize: l.buf.length }, relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: set.id } } } } })).data;
        await uploadParts(shot.attributes.uploadOperations, l.buf, l.f);
        await api("PATCH", `/v1/appScreenshots/${shot.id}`, { data: { type: "appScreenshots", id: shot.id, attributes: { uploaded: true, sourceFileChecksum: l.md5 } } });
        ids.push(shot.id);
      }
      await api("PATCH", `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, { data: ids.map((id) => ({ type: "appScreenshots", id })) });
      log(`  ✓ appstore/${e.target}: uploaded ${ids.length} (${t.ascType})`);
    }
  }
  // Previews: one MP4 per preview set.
  const psets = (await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appPreviewSets?limit=50`)).data;
  for (const [tk, t] of Object.entries(SPECS.appstore.targets).filter(([, t]) => t.kind === "preview")) {
    if (t.required === "ipad" && !app.m.ipad) continue; // an old build may have left this video behind
    const f = join(app.out, "appstore", `${tk}.mp4`);
    if (!existsSync(f)) continue;
    if (dryRun) { log(`  appstore/${tk}: would upload preview to ${t.ascType}`); continue; }
    const buf = readFileSync(f), sum = md5(buf);
    let set = psets.find((x) => x.attributes.previewType === t.ascType);
    if (!set) set = (await api("POST", "/v1/appPreviewSets", { data: { type: "appPreviewSets", attributes: { previewType: t.ascType }, relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } } })).data;
    const remote = (await api("GET", `/v1/appPreviewSets/${set.id}/appPreviews?limit=3`)).data;
    if (remote.length === 1 && remote[0].attributes.fileSize === buf.length && remote[0].attributes.assetDeliveryState?.state !== "FAILED") { log(`  ✓ appstore/${tk}: up to date`); continue; }
    for (const r of remote) await api("DELETE", `/v1/appPreviews/${r.id}`);
    const p = (await api("POST", "/v1/appPreviews", { data: { type: "appPreviews", attributes: { fileName: basename(f), fileSize: buf.length, mimeType: "video/mp4" }, relationships: { appPreviewSet: { data: { type: "appPreviewSets", id: set.id } } } } })).data;
    await uploadParts(p.attributes.uploadOperations, buf, basename(f));
    await api("PATCH", `/v1/appPreviews/${p.id}`, { data: { type: "appPreviews", id: p.id, attributes: { uploaded: true, sourceFileChecksum: sum, previewFrameTimeCode: "00:00:01:00" } } });
    log(`  ✓ appstore/${tk}: preview uploaded (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
  return { pushed: true, state: s.state };
}
