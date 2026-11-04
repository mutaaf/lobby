// App preview videos: the rendered "reel" frames (real screens + caption) → an H.264 MP4 that App Store
// Connect accepts: exact size, 30 fps, 15–30 s, stereo AAC track (silent: Apple's processor rejects
// previews with no audio stream), slow push-in on each screen and a short crossfade between them.
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { run, listPNG, SPECS } from "./util.mjs";

const XF = 0.5; // crossfade seconds

export async function buildPreviews(app, report, log = console.log) {
  const made = [];
  for (const e of report) {
    const t = SPECS[e.store]?.targets[e.target];
    if (t?.kind !== "preview" || e.files.length < 2) continue;
    const frames = e.files, N = frames.length;
    const total = Math.min(t.maxSec - 1, Math.max(t.minSec + 1, N * 4 - (N - 1) * XF));
    const D = (total + (N - 1) * XF) / N;
    const fps = 30, nf = Math.round(D * fps);
    const out = join(app.out, e.store, `${e.target}.mp4`);
    const args = ["-y", "-loglevel", "error"];
    for (const f of frames) args.push("-i", f); // one still each: zoompan turns it into exactly nf frames
    args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
    // Each still: upscale 2x first so zoompan's integer steps don't shimmer, push in 1.00 → 1.045.
    let fc = frames.map((_, i) => `[${i}:v]scale=${t.w * 2}:${t.h * 2},zoompan=z='1+0.045*on/${nf}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${nf}:s=${t.w}x${t.h}:fps=${fps},setsar=1,format=yuv420p[v${i}]`).join(";");
    let last = "v0";
    for (let i = 1; i < N; i++) { const off = (i * (D - XF)).toFixed(3); fc += `;[${last}][v${i}]xfade=transition=${i % 2 ? "slideleft" : "fade"}:duration=${XF}:offset=${off}[x${i}]`; last = `x${i}`; }
    args.push("-filter_complex", fc, "-map", `[${last}]`, "-map", `${N}:a`, "-c:v", "libx264", "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p", "-r", String(fps),
      "-b:v", "8M", "-c:a", "aac", "-b:a", "256k", "-t", total.toFixed(3), "-movflags", "+faststart", out);
    log(`  preview ${e.store}/${e.target}: ${N} screens, ${total.toFixed(1)} s`);
    await run("ffmpeg", args, { timeout: 600000 });
    made.push({ store: e.store, target: e.target, file: out, seconds: total, bytes: statSync(out).size });
  }
  return made;
}

/** Duration of a video in seconds (for lint). */
export async function duration(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(stdout);
}
