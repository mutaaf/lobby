#!/bin/zsh
# Generate every shot in shots.tsv (name, frames, prompt) with LTX-2.3 on Apple Silicon via ltx-2-mlx (MIT).
# Weights: dgrauet/ltx-2.3-mlx-q8 (LTX-2 Community License: free under $10M revenue; generated content
# must be disclosed, which the end card does). About 8 min per 4 s shot on an M1 Max.
set -e
GEN=${LOBBY_GEN:-~/.cache/lobby/gen}
[ -d $GEN/ltx-2-mlx ] || { mkdir -p $GEN && git clone -q https://github.com/dgrauet/ltx-2-mlx.git $GEN/ltx-2-mlx && (cd $GEN/ltx-2-mlx && uv sync --all-extras); }
mkdir -p $GEN/shots
cd $GEN/ltx-2-mlx
while IFS=$'\t' read -r name frames prompt; do
  out=$GEN/shots/$name.mp4
  [ -s $out ] && continue
  echo "$(date +%T) $name"
  uv run ltx-2-mlx generate --model dgrauet/ltx-2.3-mlx-q8 --distilled -H 1024 -W 576 -f $frames --frame-rate 24 --seed 11 \
    -o $out -p "$prompt" > $GEN/shots/$name.log 2>&1 || echo "FAIL $name (see $name.log)"
done < ${1:-${0:a:h}/shots.tsv}
