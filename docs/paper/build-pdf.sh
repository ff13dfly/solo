#!/usr/bin/env bash
# 生成论文正式版 PDF（预印本投递用）。
# md 真身不动：在临时副本上剥掉 draft 头注与 H1（标题/作者改由 metadata 出）、
# SVG 换 PNG（本机 brew python 3.14 的 pyexpat 损坏，weasyprint 因此解析不了 SVG；
# figures/*.png 是同一 SVG 的 2x 渲染，修好 python 后可改回 SVG）。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/draft-pattern-first.md"
OUT="$DIR/container-model-preprint-v1.pdf"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 - "$SRC" "$TMP/paper.md" << 'PY'
import sys, re
s = open(sys.argv[1]).read()
# 去掉文首 H1 + status blockquote（正式版的标题块由 pandoc metadata 生成）
s = re.sub(r'^# [^\n]+\n\n(?:>[^\n]*\n)+\n', '', s, count=1)
s = s.replace('figures/fig1-box-anatomy.svg', 'figures/fig1-box-anatomy.png')
s = s.replace('figures/fig2-upstream-loop.svg', 'figures/fig2-upstream-loop.png')
open(sys.argv[2], 'w').write(s)
PY

cd "$DIR"
# -f markdown-implicit_figures：关掉隐式图注，避免与文内斜体图注重复
pandoc "$TMP/paper.md" -o "$OUT" \
  --pdf-engine=weasyprint -f markdown-implicit_figures \
  --metadata title="The Container Model: An Experience Report on Enforcing Standards Across Human–AI Software Units" \
  --metadata author="Zhongqiang Fu" \
  --metadata date="August 2026"
echo "→ $OUT"
