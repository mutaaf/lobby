// Discovery: every native app under ~/Desktop/projects, whether or not it has a Lobby manifest yet.
// A project counts as native if it has an Xcode project / XcodeGen spec, an Expo config with ios/android,
// a Capacitor config, an Android Gradle app, or an Alexa skill package. New apps show up here with
// no setup: that is how future submissions get picked up.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { PROJECTS, isDir } from "./util.mjs";

const SKIP = new Set(["node_modules", ".git", "Pods", "DerivedData", "build", "dist", ".claude", ".expo", "vendor", "worktrees", ".next", "core"]);
// Projects that are templates or copies of another app, not things that ship (see AGENTS.md).
const IGNORE = new Set((process.env.LOBBY_IGNORE ?? "mobile-starter,18-0-demo,18-0-duo-graphics,lobby").split(","));

function walk(dir, depth, hit) {
  if (depth < 0) return;
  let names; try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (SKIP.has(n) || n.startsWith(".")) continue;
    const p = join(dir, n);
    hit(p, n);
    if (isDir(p) && !n.endsWith(".xcodeproj")) walk(p, depth - 1, hit);
  }
}

function grab(re, text) { const m = text.match(re); return m ? m[1] : null; }

export function discover(root = PROJECTS) {
  const apps = [];
  for (const proj of readdirSync(root)) {
    const dir = join(root, proj);
    if (!isDir(dir) || IGNORE.has(proj) || proj.startsWith(".")) continue;
    // Real checkouts only: a linked worktree (.git is a file) is a copy of an app already listed.
    if (!existsSync(join(dir, ".git")) || !statSync(join(dir, ".git")).isDirectory()) continue;
    const found = { slug: proj, dir, kinds: new Set(), ios: [], android: [], alexa: false, manifest: existsSync(join(dir, "store", "lobby.json")) };
    walk(dir, 4, (p, n) => {
      try {
        if (n === "project.yml") { const t = readFileSync(p, "utf8"); if (/PRODUCT_BUNDLE_IDENTIFIER/.test(t)) { found.kinds.add("swiftui"); for (const m of t.matchAll(/PRODUCT_BUNDLE_IDENTIFIER:\s*([\w.]+)/g)) found.ios.push(m[1]); } }
        else if (n.endsWith(".xcodeproj")) { const pb = join(p, "project.pbxproj"); if (existsSync(pb)) { found.kinds.add("xcode"); for (const m of readFileSync(pb, "utf8").matchAll(/PRODUCT_BUNDLE_IDENTIFIER = "?([\w.$()-]+)"?;/g)) found.ios.push(m[1]); } }
        else if (n === "app.json" || /^app\.config\.(js|ts)$/.test(n)) { const t = readFileSync(p, "utf8"); if (/"?ios"?\s*:|"?android"?\s*:/.test(t)) { found.kinds.add("expo"); const b = grab(/bundleIdentifier["']?\s*:\s*["']([\w.]+)/, t), a = grab(/package["']?\s*:\s*["']([\w.]+)/, t); if (b) found.ios.push(b); if (a) found.android.push(a); } }
        else if (/^capacitor\.config\.(ts|json)$/.test(n)) { const t = readFileSync(p, "utf8"); found.kinds.add("capacitor"); const id = grab(/appId["']?\s*:\s*["']([\w.]+)/, t); if (id) { found.ios.push(id); if (existsSync(join(dir, "android"))) found.android.push(id); } }
        else if (n === "build.gradle" || n === "build.gradle.kts") { const t = readFileSync(p, "utf8"); const id = grab(/applicationId\s*=?\s*["']([\w.]+)/, t); if (id) { found.kinds.add("android"); found.android.push(id); } }
        else if (n === "skill.json" || n === "ask-resources.json") { found.alexa = true; found.kinds.add("alexa"); }
      } catch { /* unreadable file: ignore */ }
    });
    const clean = (l) => [...new Set(l.filter((b) => b && !b.includes("$") && !/\.(tests?|uitests|widgets?|remote|extension|intents?|watchkitapp|clip)$/i.test(b)))];
    found.ios = clean(found.ios); found.android = clean(found.android);
    if (!found.kinds.size || (!found.ios.length && !found.android.length && !found.alexa)) continue;
    found.kinds = [...found.kinds];
    try { found.lastCommit = statSync(join(dir, ".git", "HEAD")).mtimeMs; } catch { /* none */ }
    apps.push(found);
  }
  return apps;
}
