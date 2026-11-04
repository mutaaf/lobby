// The composer: raw captures + the app's brand (store/lobby.json) → designed frames for every store
// target. Each frame is an HTML page rendered to an exact-size PNG by headless Chrome.
//
// Design rules baked in (see AGENTS.md "What good looks like"):
//  - One continuous backdrop runs across the whole set (glows + a ribbon), so the first three frames
//    read as one poster in search results, where stores show them side by side.
//  - Big, short headlines (auto-fit, max 3 lines); the screen is the hero, never a thumbnail.
//  - Android/Play frames never show Apple hardware or the iOS status bar.
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname, resolve } from "node:path";
import { CHROME, SPECS, mkdirp, imageSize, run, pool, rng, markup, esc, listPNG, alpha, lum } from "./util.mjs";
import { fontFaces } from "./fonts.mjs";

const SOURCES = ["iphone", "ipad", "duo"];

/** Load an app: its manifest plus every raw capture, grouped by source. */
export function loadApp(dir) {
  dir = resolve(dir);
  const f = join(dir, "store", "lobby.json");
  if (!existsSync(f)) throw new Error(`${dir} has no store/lobby.json (run: lobby init ${dir})`);
  const m = JSON.parse(readFileSync(f, "utf8"));
  const raw = {};
  for (const s of SOURCES) {
    // raw.<source> is a folder, or { dir, prefix } when one folder holds several sources (p2-house.png, i2-house.png).
    const spec = typeof m.raw?.[s] === "object" ? m.raw[s] : { dir: m.raw?.[s] ?? `store/lobby/raw/${s}`, prefix: "" };
    const d = join(dir, spec.dir), pre = spec.prefix ?? "";
    raw[s] = listPNG(d).filter((n) => n.startsWith(pre)).map((n) => ({ id: basename(n, extname(n)).slice(pre.length), file: join(d, n), ...imageSize(join(d, n)) }))
      .filter((r) => s !== "iphone" || r.h / r.w > 1.8).filter((r) => s !== "ipad" || (r.h / r.w > 1.2 && r.h / r.w < 1.5));
  }
  return { dir, m, raw, out: join(dir, m.out ?? "store/lobby/out") };
}

export function findRaw(app, source, id) {
  const list = app.raw[source] ?? [];
  const bare = (x) => x.replace(/^\d+[-_]/, "").replace(/[-_](outer|inner)$/, "");
  return list.find((r) => r.id === id) ?? list.find((r) => r.id.startsWith(id)) ?? list.find((r) => r.id.includes(id)) ?? list.find((r) => bare(r.id) === bare(id));
}

const dataURI = (file) => `data:image/${/\.png$/i.test(file) ? "png" : "jpeg"};base64,${readFileSync(file).toString("base64")}`;

// ─── backdrop ────────────────────────────────────────────────────────────────────────────────
function noise(ink) {
  const [r, g, b] = ink === "light" ? [1, 1, 1] : [0.08, 0.08, 0.12];
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='360' height='360'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 ${r}  0 0 0 0 ${g}  0 0 0 0 ${b}  0 0 0 .6 0'/></filter><rect width='360' height='360' filter='url(%23n)'/></svg>`)}")`;
}

function texture(kind, W, H, B, R) {
  const u = W / 100;
  switch (kind) {
    case "stars": {
      let s = "";
      for (let i = 0; i < Math.round((W * H) / 9000); i++) {
        const x = R() * W, y = R() * H, rr = (R() ** 3) * 0.32 * u + 0.08 * u;
        s += `<circle cx='${x.toFixed(1)}' cy='${y.toFixed(1)}' r='${rr.toFixed(2)}' fill='${B.ink}' opacity='${(0.25 + R() * 0.6).toFixed(2)}'/>`;
      }
      for (let i = 0; i < 6; i++) { // a few twinkles
        const x = R() * W, y = R() * H, l = (1.2 + R() * 1.6) * u;
        s += `<path d='M${x} ${y - l}L${x + l * .18} ${y - l * .18}L${x + l} ${y}L${x + l * .18} ${y + l * .18}L${x} ${y + l}L${x - l * .18} ${y + l * .18}L${x - l} ${y}L${x - l * .18} ${y - l * .18}Z' fill='${B.accent}' opacity='.75'/>`;
      }
      return `<svg class="tex" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${s}</svg>`;
    }
    case "field": // yard lines: football / sports
      return `<div class="tex" style="background:repeating-linear-gradient(0deg,transparent 0 ${(H / 11 - 3).toFixed(0)}px,${alpha(B.ink, .07)} ${(H / 11 - 3).toFixed(0)}px ${(H / 11).toFixed(0)}px),repeating-linear-gradient(90deg,transparent 0 ${(W / 5 - 2).toFixed(0)}px,${alpha(B.ink, .035)} ${(W / 5 - 2).toFixed(0)}px ${(W / 5).toFixed(0)}px)"></div>`;
    case "grid":
      return `<div class="tex" style="background-image:linear-gradient(${alpha(B.ink, .06)} 2px,transparent 2px),linear-gradient(90deg,${alpha(B.ink, .06)} 2px,transparent 2px);background-size:${(6 * u).toFixed(0)}px ${(6 * u).toFixed(0)}px"></div>`;
    case "dots":
      return `<div class="tex" style="background-image:radial-gradient(${alpha(B.ink, .13)} ${(.28 * u).toFixed(1)}px,transparent ${(.32 * u).toFixed(1)}px);background-size:${(3.4 * u).toFixed(0)}px ${(3.4 * u).toFixed(0)}px"></div>`;
    case "scan": // CRT scanlines: retro
      return `<div class="tex" style="background:repeating-linear-gradient(0deg,${alpha(B.ink, .045)} 0 2px,transparent 2px 6px)"></div>`;
    default: return "";
  }
}

/** One wide backdrop for the whole set; frame i shows slice i. */
function panorama(app, W, H, i, N, tall) {
  const B = app.m.brand, R = rng(`${app.m.slug}:${W}x${H}`);
  const glows = B.glow ?? [B.accent, B.accent2 ?? B.accent];
  let g = "";
  for (let k = 0; k < N * 2 + 1; k++) {
    const x = (k / 2) * W + (R() - .5) * W * .5, y = (tall ? .12 : .1) * H + R() * H * .85, s = (.55 + R() * .55) * Math.min(W, H) * (tall ? 1 : 1.3);
    g += `<i class="glow" style="left:${(x - s / 2).toFixed(0)}px;top:${(y - s / 2).toFixed(0)}px;width:${s.toFixed(0)}px;height:${s.toFixed(0)}px;background:${glows[k % glows.length]}"></i>`;
  }
  let ribbon = "";
  if (B.ribbon !== false) {
    const pts = [];
    for (let j = -1; j <= N; j++) pts.push([(j + .5) * W, (j % 2 ? .5 : .88) * H + (R() - .5) * .08 * H]);
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let j = 1; j < pts.length; j++) { const [x0, y0] = pts[j - 1], [x1, y1] = pts[j], mx = (x0 + x1) / 2; d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`; }
    const sw = Math.min(W, H) * .06;
    ribbon = `<svg class="ribbon" width="${N * W}" height="${H}" viewBox="0 0 ${N * W} ${H}"><defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" stop-color="${B.accent}"/><stop offset=".5" stop-color="${B.accent2 ?? B.accent}"/><stop offset="1" stop-color="${B.accent}"/></linearGradient></defs>
      <path d="${d}" fill="none" stroke="url(#rg)" stroke-width="${sw.toFixed(0)}" stroke-linecap="round" opacity=".9"/>
      <path d="${d}" fill="none" stroke="${B.ink}" stroke-width="${(sw * .08).toFixed(1)}" stroke-dasharray="${(sw * .5).toFixed(0)} ${(sw * .5).toFixed(0)}" opacity=".35" transform="translate(0 ${(sw * 1.1).toFixed(0)})"/></svg>`;
  }
  return `<div class="pano" style="width:${N * W}px;left:${-i * W}px">${g}${ribbon}</div>${texture(B.texture, W, H, B, R)}<div class="grain"></div>`;
}

// ─── devices ─────────────────────────────────────────────────────────────────────────────────
/** A device around a capture. kind: iphone | ipad | android | tablet | duo | bare. Returns {html, h, screen:{x,y,w,h}}. */
function device(kind, { raw, src, x, y, w, rot = 0, z = 5, cls = "" }) {
  const shape = { iphone: [.024, .155], duo: [.026, .11], ipad: [.03, .065], android: [.022, .095], tablet: [.026, .05], bare: [0, .07] }[kind];
  const bz = Math.round(w * shape[0]), r = Math.round(w * shape[1]);
  const sw = w - 2 * bz, sh = Math.round(sw * raw.h / raw.w), h = sh + 2 * bz;
  const phoneRaw = raw.h / raw.w > 1.8;
  let extra = "";
  if (kind === "iphone") extra = `<i class="island" style="width:${(sw * .31).toFixed(0)}px;height:${(sw * .088).toFixed(0)}px;top:${(sw * .03).toFixed(0)}px"></i>`;
  if (kind === "android" || kind === "tablet") {
    const band = Math.round(sh * (phoneRaw ? .058 : .021)), cam = Math.round(sw * (kind === "android" ? .034 : .014));
    extra = `<div class="astatus" style="height:${band}px;font-size:${(band * .42).toFixed(0)}px;padding:0 ${(sw * .06).toFixed(0)}px"><span>9:41</span><span class="aicons">${androidIcons(band * .42)}</span></div>`
      + `<i class="punch" style="width:${cam}px;height:${cam}px;top:${(band / 2 - cam / 2).toFixed(0)}px"></i>`;
  }
  const html = `<div class="dev dev-${kind} ${cls}" style="--bz:${bz}px;--r:${r}px;left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${w.toFixed(0)}px;transform:rotate(${rot}deg);z-index:${z}">
    <div class="screen" style="height:${sh}px"><img src="${src}" style="width:${sw}px;height:${sh}px">${extra}</div></div>`;
  return { html, h, screen: { x: x + bz, y: y + bz, w: sw, h: sh } };
}
const androidIcons = (s) => `<svg width="${(s * 3.6).toFixed(0)}" height="${s.toFixed(0)}" viewBox="0 0 36 10" fill="currentColor"><path d="M1 9h2V6H1zm3 0h2V4H4zm3 0h2V2H7zm3 0h2V0h-2z"/><path d="M17 9l5-6a8 8 0 0 0-10 0z" transform="translate(1 0)"/><rect x="26" y="1.5" width="8" height="7" rx="1.2"/><rect x="34.3" y="3.5" width="1.2" height="3"/></svg>`;
const deviceFor = (target, raw) => target.device === "ipad" && raw.h / raw.w > 1.8 ? "iphone" : target.device === "tablet" && raw.h / raw.w > 1.8 ? "android" : target.device;

// ─── text ────────────────────────────────────────────────────────────────────────────────────
function textBlock({ n, shot, x, y, w, h, size, align = "left", cls = "" }) {
  return `<div class="tb ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;text-align:${align};--fs:${size}px">
    ${shot.kicker ? `<div class="kicker" style="justify-content:${align === "center" ? "center" : "flex-start"}">${n ? `<b>${String(n).padStart(2, "0")}</b>` : ""}${esc(shot.kicker)}</div>` : ""}
    <h1 class="fit">${markup(shot.title)}</h1>${shot.sub ? `<p class="sub">${markup(shot.sub)}</p>` : ""}</div>`;
}
function burst(points = 20, inner = .84) {
  const p = [];
  for (let i = 0; i < points * 2; i++) { const a = Math.PI * i / points - Math.PI / 2, r = i % 2 ? inner : 1; p.push(`${(50 + 50 * r * Math.cos(a)).toFixed(2)}% ${(50 + 50 * r * Math.sin(a)).toFixed(2)}%`); }
  return `polygon(${p.join(",")})`;
}
// Starburst sticker. Text size follows the longest word so it never spills; position is clamped inside the frame.
let FRAME_W = 0, FRAME_H = 0;
function sticker(text, x, y, d, rot = -12) {
  if (!text) return "";
  const words = text.replace(/[*_|]/g, " ").split(/\s+/).filter(Boolean), long = Math.max(...words.map((w) => w.length));
  const lines = Math.max(1, Math.ceil(text.length / Math.max(long, 6)));
  const fs = Math.min(d * .14, d * .64 / (long * .88), d * .58 / (lines * 1.2));
  x = Math.max(FRAME_W * .015, Math.min(FRAME_W - d * 1.02, x)); y = Math.max(FRAME_H * .015, Math.min(FRAME_H - d * 1.02, y));
  return `<div class="sticker" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${d.toFixed(0)}px;height:${d.toFixed(0)}px;font-size:${fs.toFixed(0)}px;transform:rotate(${rot}deg)"><span>${markup(text)}</span></div>`;
}

// ─── page shell ──────────────────────────────────────────────────────────────────────────────
async function shell(app, W, H, body) {
  const B = app.m.brand;
  const fonts = (await fontFaces(B.display, "Display", app.dir)) + (await fontFaces(B.body ?? B.display, "Body", app.dir)) + (await fontFaces(B.mono ?? B.body ?? B.display, "Mono", app.dir));
  const dark = (B.mode ?? (lum(B.bg) < .3 ? "dark" : "light")) === "dark";
  const u = Math.min(W, H) / 100;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
:root{--bg:${B.bg};--bg2:${B.bg2 ?? B.bg};--ink:${B.ink};--muted:${B.muted ?? alpha(B.ink, .72)};--accent:${B.accent};--accent2:${B.accent2 ?? B.accent};--hl:${B.highlight ?? alpha(B.accent2 ?? B.accent, .55)};--u:${u}px}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{background:radial-gradient(120% 80% at 20% 0%,var(--bg2),var(--bg) 70%);color:var(--ink);font-family:Body,sans-serif;position:relative;-webkit-font-smoothing:antialiased}
.pano{position:absolute;top:0;height:${H}px;z-index:0}
.glow{position:absolute;border-radius:50%;filter:blur(${(9 * u).toFixed(0)}px);opacity:${dark ? .5 : .42}}
.ribbon{position:absolute;left:0;top:0}
.tex{position:absolute;inset:0;z-index:1;pointer-events:none}
.grain{position:absolute;inset:0;z-index:30;pointer-events:none;background-image:${noise(dark ? "light" : "dark")};opacity:${dark ? .06 : .08};mix-blend-mode:${dark ? "screen" : "multiply"}}
.tb{position:absolute;z-index:20;display:flex;flex-direction:column;gap:calc(var(--fs)*.22)}
.kicker{font-family:Mono,monospace;font-weight:700;font-size:calc(var(--fs)*.27);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);display:flex;align-items:center;gap:.8em}
.kicker b{display:inline-grid;place-items:center;background:var(--ink);color:var(--bg);border-radius:999px;padding:.3em .75em;letter-spacing:.05em}
h1{font-family:Display,sans-serif;font-weight:${B.displayWeight ?? 800};font-size:var(--fs);line-height:${B.lineHeight ?? .95};letter-spacing:${B.tracking ?? "-.035em"};text-wrap:balance}
h1 em{font-style:normal;color:var(--accent)}
h1 u{text-decoration:none;position:relative;z-index:0;white-space:nowrap}
h1 u::after{content:'';position:absolute;left:-.04em;right:-.06em;bottom:.06em;height:.3em;background:var(--hl);z-index:-1;transform:skew(-12deg) rotate(-1.2deg);border-radius:.06em}
.sub{font-weight:600;font-size:calc(var(--fs)*.36);line-height:1.28;color:var(--muted);text-wrap:pretty}
.sub em{font-style:normal;color:var(--ink);font-weight:800}
.dev{position:absolute;border-radius:var(--r);padding:var(--bz);transform-origin:50% 40%;
  background:linear-gradient(150deg,#41434f 0%,#16171e 36%,#0b0c11 70%,#30323e 100%);
  box-shadow:inset 0 0 0 calc(var(--bz)*.09) rgba(255,255,255,.18),inset 0 0 0 calc(var(--bz)*.3) #07080c,0 calc(var(--u)*6) calc(var(--u)*12) calc(var(--u)*-2) ${alpha(B.shadow ?? B.accent, .55)},0 calc(var(--u)*3) calc(var(--u)*5) calc(var(--u)*-1) rgba(0,0,0,.45)}
.dev-android,.dev-tablet{background:linear-gradient(160deg,#2b2e35,#121317 60%,#24262c)}
.dev-bare{padding:0;background:none;box-shadow:0 calc(var(--u)*5) calc(var(--u)*10) calc(var(--u)*-2) ${alpha(B.shadow ?? B.accent, .5)},0 0 0 calc(var(--u)*.35) ${alpha(B.ink, .14)}}
.screen{position:relative;overflow:hidden;border-radius:calc(var(--r) - var(--bz));background:#000}
.screen img{display:block}
.island{position:absolute;left:50%;transform:translateX(-50%);background:#000;border-radius:999px}
.punch{position:absolute;left:50%;transform:translateX(-50%);background:#050505;border-radius:50%;box-shadow:0 0 0 2px rgba(255,255,255,.08)}
.astatus{position:absolute;left:0;right:0;top:0;display:flex;align-items:center;justify-content:space-between;font-family:Body,sans-serif;font-weight:600;color:#fff}
.aicons{display:flex;align-items:center}
.sticker{position:absolute;z-index:25;display:flex;align-items:center;justify-content:center;text-align:center;background:var(--accent);color:${lum(B.accent) > .45 ? "#111" : "#fff"};clip-path:${burst()};font-family:Mono,monospace;font-weight:700;text-transform:uppercase;letter-spacing:.05em;line-height:1.12;padding:14%;text-wrap:balance}
.sticker em{font-style:normal}
.mag{position:absolute;z-index:22;border-radius:50%;background-repeat:no-repeat;box-shadow:0 0 0 calc(var(--u)*1.1) var(--ink),0 0 0 calc(var(--u)*2) var(--accent),0 calc(var(--u)*4) calc(var(--u)*9) rgba(0,0,0,.45)}
.ring{position:absolute;z-index:21;border-radius:50%;box-shadow:0 0 0 calc(var(--u)*.6) var(--accent),0 0 calc(var(--u)*4) var(--accent)}
.wire{position:absolute;left:0;top:0;z-index:21;overflow:visible}
.panel{position:absolute;z-index:19;border-radius:calc(var(--u)*6);background:${alpha(B.bg, .72)};backdrop-filter:blur(calc(var(--u)*3)) saturate(1.4);box-shadow:inset 0 0 0 2px ${alpha(B.ink, .12)},0 calc(var(--u)*3) calc(var(--u)*8) rgba(0,0,0,.35)}
.lockup{position:absolute;z-index:20;display:flex;align-items:center;gap:calc(var(--u)*3)}
.lockup img{border-radius:22.5%;box-shadow:0 calc(var(--u)*1.5) calc(var(--u)*4) rgba(0,0,0,.35)}
.lockup b{font-family:Display,sans-serif;font-weight:${B.displayWeight ?? 800};letter-spacing:-.02em}
.lockup small{display:block;font-family:Mono,monospace;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
</style></head><body>${body}
<script>
// Fit every headline into its box; sample the colour under each Android status bar.
document.fonts.ready.then(function(){
  document.querySelectorAll('.tb').forEach(function(tb){
    var fs=parseFloat(getComputedStyle(tb).getPropertyValue('--fs')), h1=tb.querySelector('h1'), i=0;
    function lines(){var lh=parseFloat(getComputedStyle(h1).lineHeight)||fs; return Math.round(h1.scrollHeight/lh);}
    while(i++<60 && (tb.scrollHeight>tb.clientHeight+1 || lines()>3 || h1.scrollWidth>h1.clientWidth+1)){fs*=.96; tb.style.setProperty('--fs',fs+'px');}
  });
  document.querySelectorAll('.astatus').forEach(function(bar){
    var img=bar.parentNode.querySelector('img'), c=document.createElement('canvas'); c.width=img.naturalWidth; c.height=img.naturalHeight;
    var x=c.getContext('2d'); x.drawImage(img,0,0);
    var row=Math.min(c.height-1, Math.round(bar.offsetHeight/img.height*img.naturalHeight)+2), d=x.getImageData(0,row,c.width,1).data, r=0,g=0,b=0,n=0;
    for(var k=0;k<d.length;k+=16){r+=d[k];g+=d[k+1];b+=d[k+2];n++;}
    r=Math.round(r/n);g=Math.round(g/n);b=Math.round(b/n);
    bar.style.background='rgb('+r+','+g+','+b+')'; bar.style.color=(0.299*r+0.587*g+0.114*b)>150?'#111':'#fff';
  });
});
</script></body></html>`;
}

// ─── layouts ─────────────────────────────────────────────────────────────────────────────────
const LAYOUTS = ["cover", "hero", "tilt", "bleed", "spotlight", "duo"];

function portrait(app, target, shot, i, N, raw, raw2, src, src2) {
  FRAME_W = target.w; FRAME_H = target.h;
  const W = target.w, H = target.h, tall = H / W > 1.6, B = app.m.brand;
  const PX = Math.round(W * .07), a = raw.h / raw.w;
  const kind = deviceFor(target, raw);
  let layout = shot.layout ?? (i === 0 ? "cover" : LAYOUTS[1 + ((i - 1) % 3)]);
  if (layout === "duo" && !raw2) layout = "tilt";
  if (layout === "spotlight" && !shot.focus) layout = "hero";
  const fs = Math.round(W * (tall ? .108 : .082));
  const textTop = Math.round(H * (tall ? .05 : .045)), textH = Math.round(H * (tall ? .245 : .2));
  const devTop = textTop + textH + Math.round(H * .025);
  const fitW = (fw, room) => Math.min(fw * W, room / (a * 1.02));
  let body = "", n = i + 1;
  const tb = (o = {}) => textBlock({ n, shot, x: PX, y: textTop, w: W - 2 * PX, h: textH, size: fs, ...o });

  if (layout === "cover") {
    const icon = app.iconURI, isz = Math.round(W * (tall ? .13 : .085));
    const lock = `<div class="lockup" style="left:${PX}px;top:${textTop}px">${icon ? `<img src="${icon}" width="${isz}" height="${isz}">` : ""}<div><b style="font-size:${(isz * .42).toFixed(0)}px">${esc(app.m.name)}</b><small style="font-size:${(isz * .17).toFixed(0)}px">${esc(app.m.category ?? "")}</small></div></div>`;
    const ty = textTop + isz + Math.round(H * .025);
    body += lock + textBlock({ n: 0, shot: { ...shot, kicker: shot.kicker && !icon ? shot.kicker : null }, x: PX, y: ty, w: W - 2 * PX, h: Math.round(H * (tall ? .2 : .17)), size: Math.round(fs * 1.12) });
    const top = ty + Math.round(H * (tall ? .215 : .185));
    const w = fitW(.8, H - top + H * .12), d = device(kind, { raw, src, x: (W - w) / 2, y: top, w, rot: 0 });
    body += d.html + sticker(shot.badge, W - W * .3, top + H * .1, W * .27, 10);
  } else if (layout === "hero") {
    const w = fitW(.8, H - devTop + H * .1), d = device(kind, { raw, src, x: (W - w) / 2, y: devTop, w });
    body += tb() + d.html + sticker(shot.badge, PX * .2, devTop + d.h * .32, W * .26, -12);
  } else if (layout === "tilt") {
    const w = fitW(.74, H - devTop + H * .06), d = device(kind, { raw, src, x: (W - w) / 2 + W * .07, y: devTop + H * .01, w, rot: -6 });
    body += tb() + d.html + sticker(shot.badge, PX * .1, devTop + d.h * .4, W * .27, -14);
  } else if (layout === "bleed") {
    const w = fitW(.9, H * .97), d = device(kind, { raw, src, x: (W - w) / 2, y: H * .035, w });
    const ph = Math.round(H * (tall ? .27 : .25)), py = H - ph - Math.round(H * .035);
    body += d.html + `<div class="panel" style="left:${PX * .6}px;top:${py}px;width:${W - PX * 1.2}px;height:${ph}px"></div>`
      + textBlock({ n, shot, x: PX * 1.2, y: py + ph * .1, w: W - PX * 2.4, h: ph * .8, size: Math.round(fs * .9) }) + sticker(shot.badge, W - W * .3, py - W * .2, W * .26, 12);
  } else if (layout === "spotlight") {
    const w = fitW(.62, H - devTop + H * .04), d = device(kind, { raw, src, x: W * .05, y: devTop, w });
    const [cx, cy, fw] = shot.focus, D = Math.min(W * .5, H * .3);
    const bgW = D / fw, bgH = bgW * a;
    const fx = d.screen.x + cx * d.screen.w, fy = d.screen.y + cy * d.screen.h, fr = fw * d.screen.w / 2;
    const mx = W - W * .04 - D, my = Math.max(devTop, Math.min(H - D - H * .04, fy - D / 2 - H * .04));
    body += tb() + d.html
      + `<i class="ring" style="left:${fx - fr}px;top:${fy - fr}px;width:${2 * fr}px;height:${2 * fr}px"></i>`
      + `<svg class="wire" width="${W}" height="${H}"><line x1="${fx + fr * .7}" y1="${fy}" x2="${mx + D * .12}" y2="${my + D / 2}" stroke="${B.accent}" stroke-width="${W * .006}" stroke-dasharray="${W * .018} ${W * .012}" stroke-linecap="round"/></svg>`
      + `<div class="mag" style="left:${mx}px;top:${my}px;width:${D}px;height:${D}px;background-image:url('${src}');background-size:${bgW}px ${bgH}px;background-position:${D / 2 - cx * bgW}px ${D / 2 - cy * bgH}px"></div>`
      + sticker(shot.badge, mx + D * .55, my + D * .78, W * .22, 10);
  } else if (layout === "duo") {
    const w = fitW(.6, H - devTop), d2 = device(deviceFor(target, raw2), { raw: raw2, src: src2, x: W * .04, y: devTop + H * .06, w: w * .92, rot: -7, z: 4, cls: "back" });
    const d = device(kind, { raw, src, x: W - w - W * .04, y: devTop + H * .01, w, rot: 4, z: 6 });
    body += tb() + d2.html + d.html + sticker(shot.badge, W * .36, devTop + H * .5, W * .24, -8);
  }
  return { body, layout };
}

function landscape(app, target, shots) {
  const W = target.w, H = target.h, B = app.m.brand, f = app.m.feature ?? {};
  const isz = Math.round(H * .2), PX = Math.round(W * .055);
  const usable = shots.filter((s) => s.raw).slice(0, 2);
  const noDevices = target.store === "alexa" || usable.length === 0;
  const textW = noDevices ? W - 2 * PX : W * .5;
  let body = `<div class="lockup" style="left:${PX}px;top:${H * .1}px">${app.iconURI ? `<img src="${app.iconURI}" width="${isz}" height="${isz}">` : ""}<div><b style="font-size:${(isz * .4).toFixed(0)}px">${esc(app.m.name)}</b><small style="font-size:${(isz * .15).toFixed(0)}px">${esc(app.m.category ?? "")}</small></div></div>`;
  body += textBlock({ n: 0, shot: { title: f.title ?? app.m.tagline, sub: f.sub }, x: PX, y: H * .1 + isz + H * .07, w: textW, h: H * .9 - (H * .1 + isz + H * .07) - H * .06, size: Math.round(H * .13) });
  if (!noDevices) {
    usable.forEach((s, k) => {
      const w = H * (k ? 1.05 : 1.25) / (s.raw.h / s.raw.w);
      const d = device(s.raw.h / s.raw.w > 1.8 ? (target.store === "play" || target.store === "amazon" ? "android" : "iphone") : "ipad",
        { raw: s.raw, src: s.src, x: W * (k ? .79 : .6), y: H * (k ? .22 : .1), w, rot: k ? 12 : 6, z: k ? 4 : 6 });
      body += d.html;
    });
  }
  return body;
}

/** Preview-video frame: the real screen, no hardware (Apple's rule for previews), caption on top. */
function reel(app, target, shot, i, N, raw, src) {
  const W = target.w, H = target.h, PX = Math.round(W * .07);
  const capH = Math.round(H * .16), top = capH + Math.round(H * .05);
  const w = Math.min(W * .86, (H - top + H * .1) / (raw.h / raw.w));
  const d = device("bare", { raw, src, x: (W - w) / 2, y: top, w });
  return textBlock({ n: 0, shot: { ...shot, sub: null }, x: PX, y: Math.round(H * .035), w: W - 2 * PX, h: capH, size: Math.round(W * .095), align: "center" }) + d.html;
}

// ─── render ──────────────────────────────────────────────────────────────────────────────────
async function chrome(html, file, W, H) {
  const tmp = file.replace(/\.png$/, ".html");
  writeFileSync(tmp, html);
  rmSync(file, { force: true });
  // Own profile per run (parallel Chromes sharing one profile crash); Chrome often exits non-zero on
  // teardown ("Teardown watchdog expired") after writing the screenshot, so the file decides success.
  const profile = mkdtempSync(join(tmpdir(), "lobby-chrome-"));
  try {
    await run(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files",
      "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`,
      "--virtual-time-budget=6000", `--screenshot=${file}`, `--window-size=${W},${H}`, `file://${tmp}`], { timeout: 120000 });
  } catch (e) { if (!existsSync(file)) throw new Error(`Chrome failed on ${tmp}: ${(e.stderr ?? e.message).split("\n").filter((l) => !/ERROR:|WARNING:/.test(l)).slice(-3).join(" ")}`); }
  finally { rmSync(profile, { recursive: true, force: true }); }
  const { w, h } = imageSize(file);
  if (w !== W || h !== H) throw new Error(`${file}: rendered ${w}×${h}, wanted ${W}×${H}`);
  if (!process.env.LOBBY_KEEP_HTML) rmSync(tmp);
  return file;
}

/** Which shots a target gets: shot.stores limits it; the target's max caps it. */
function shotsFor(app, storeKey, target) {
  return (app.m.shots ?? []).filter((s) => !s.stores || s.stores.includes(storeKey)).slice(0, target.max ?? 10);
}

function resolveRaw(app, target, shot, which = "raw") {
  const id = shot[which]; if (!id) return null;
  for (const s of [target.source, target.fallbackSource].filter(Boolean)) { const r = findRaw(app, s, id); if (r) return r; }
  return null;
}

/** Render every target of the given stores. Returns [{store, target, files, skipped}] */
export async function render(app, { stores = app.m.stores ?? ["appstore"], only, jobs = 3, log = console.log } = {}) {
  const iconFile = app.m.icon ? join(app.dir, app.m.icon) : null;
  app.iconURI = iconFile && existsSync(iconFile) ? dataURI(iconFile) : null;
  const report = [];
  const tasks = [];
  for (const storeKey of stores) {
    const store = SPECS[storeKey];
    if (!store) throw new Error(`Unknown store "${storeKey}" (specs/stores.json has: ${Object.keys(SPECS).join(", ")})`);
    for (const [tk, t0] of Object.entries(store.targets)) {
      if (only && !only.includes(`${storeKey}/${tk}`) && !only.includes(storeKey)) continue;
      const target = { ...t0, store: storeKey, key: tk };
      if (target.required === "ipad" && !app.m.ipad) continue;
      if (target.kind === "preview" && app.m.previews === false) continue;
      const dir = mkdirp(join(app.out, storeKey, tk));
      for (const f of listPNG(dir)) rmSync(join(dir, f)); // a target folder is exactly the current set
      const entry = { store: storeKey, target: tk, label: target.label, files: [], skipped: [] };
      report.push(entry);
      // bespoke: hand-made frames that already beat the composer for this target: copy, don't compose.
      const own = app.m.bespoke?.[`${storeKey}/${tk}`];
      if (own) {
        const [d, pre = ""] = [join(app.dir, own.dir ?? own), own.prefix];
        for (const n of listPNG(d).filter((n) => n.startsWith(pre)).slice(0, target.max ?? 10)) { const to = join(dir, n); copyFileSync(join(d, n), to); entry.files.push(to); }
        entry.bespoke = true;
        continue;
      }
      if (target.alias) { entry.aliasOf = target.alias; continue; } // copied after the source renders
      if (target.kind === "icon") {
        if (!iconFile || !existsSync(iconFile)) { entry.skipped.push("no icon in manifest"); continue; }
        const f = join(dir, "icon.png");
        tasks.push(async () => { await run("sips", ["-s", "format", "png", "-z", String(target.h), String(target.w), iconFile, "--out", f]); entry.files.push(f); });
        continue;
      }
      const shots = shotsFor(app, storeKey, target);
      if (target.kind === "feature") {
        const src = shots.map((s) => { const raw = resolveRaw(app, { source: "iphone", fallbackSource: "ipad" }, s); return raw ? { ...s, raw, src: dataURI(raw.file) } : s; });
        const f = join(dir, `${tk}.png`);
        tasks.push(async () => {
          const html = await shell(app, target.w, target.h, panorama(app, target.w, target.h, 0, 1, false) + landscape(app, target, src));
          entry.files.push(await chrome(html, f, target.w, target.h));
        });
        continue;
      }
      if (target.source === "duo" && !app.raw.duo.length) { entry.skipped.push("no duo captures"); continue; }
      const usable = shots.map((s) => ({ s, raw: resolveRaw(app, target, s), raw2: resolveRaw(app, target, s, "raw2") })).filter((x) => x.raw || entry.skipped.push(`${x.s.raw}: no ${target.source} capture`) && false);
      const N = usable.length;
      usable.forEach(({ s, raw, raw2 }, i) => {
        const f = join(dir, `${String(i + 1).padStart(2, "0")}-${s.id ?? s.raw}.png`);
        tasks.push(async () => {
          const src = dataURI(raw.file), src2 = raw2 ? dataURI(raw2.file) : null;
          const body = target.kind === "preview" ? reel(app, target, s, i, N, raw, src) : portrait(app, target, s, i, N, raw, raw2, src, src2).body;
          const html = await shell(app, target.w, target.h, panorama(app, target.w, target.h, i, N, target.h / target.w > 1.6) + body);
          entry.files[i] = await chrome(html, f, target.w, target.h);
        });
      });
    }
  }
  let done = 0;
  await pool(tasks, jobs, async (t) => { await t(); if (++done % 5 === 0 || done === tasks.length) log(`  rendered ${done}/${tasks.length}`); });
  for (const e of report) {
    e.files = e.files.filter(Boolean);
    if (!e.aliasOf) continue;
    const src = report.find((x) => `${x.store}/${x.target}` === e.aliasOf);
    if (!src) { e.skipped.push(`alias ${e.aliasOf} not rendered`); continue; }
    const max = SPECS[e.store].targets[e.target].max ?? 10;
    for (const f of src.files.slice(0, max)) { const to = join(app.out, e.store, e.target, basename(f)); copyFileSync(f, to); e.files.push(to); }
  }
  return report;
}
