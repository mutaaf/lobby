"""Beat grid + most energetic 20 s window for each track in $LOBBY_STOCK/music → analysis.json.
Timelines give segments in `beats`; reel.py snaps every cut to this grid."""
import glob, json, os
import librosa
import numpy as np

STOCK = os.path.expanduser(os.environ.get("LOBBY_STOCK", "~/.cache/lobby/stock"))
res = {}
for f in sorted(glob.glob(f"{STOCK}/music/*.mp3")):
    y, sr = librosa.load(f, sr=22050, mono=True)
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    rms = librosa.feature.rms(y=y)[0]
    t = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
    best = (0.0, -1.0)
    for s in np.arange(0, max(1, t[-1] - 20), 0.5):
        m = (t >= s) & (t < s + 20)
        if m.any() and rms[m].mean() > best[1]:
            best = (s, rms[m].mean())
    start = beats[np.argmin(abs(beats - best[0]))] if len(beats) else best[0]
    k = os.path.basename(f)[:-4]
    res[k] = {"bpm": round(float(np.atleast_1d(tempo)[0]), 1), "start": round(float(start), 2), "beats": [round(float(b), 3) for b in beats]}
    print(k, res[k]["bpm"], "bpm, peak at", res[k]["start"])
json.dump(res, open(f"{STOCK}/music/analysis.json", "w"))
