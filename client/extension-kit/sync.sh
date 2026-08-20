#!/usr/bin/env bash
#
# 把 kit 的 lib/ 同步进一个扩展目录的 kit/ 子目录。
#
# 🔴 **为什么必须复制进去，不能 import 出去**：Chrome 扩展的根目录是一个封闭的树,
#    `import '../../somewhere/rpc.js'` 越过扩展根就加载不到。而它的症状极坏——
#    service worker **注册得起来、不报错**,但整个模块从未求值,任何调用都石沉大海。
#    (2026-08-20 实测:playwright 里表现为 `sw.evaluate()` 永久挂住,而 SW 的 URL
#    看起来一切正常。) 所以 kit 必须有一份在扩展根内部。
#
# 用法:
#   bash sync.sh sample                    # 同步给仓库自带的 sample
#   bash sync.sh ../extension              # 同步给你自己的扩展
#
# upgrade.sh 会在升级时自动对项目的 client/extension/ 做同一件事,不用手动跑。
set -euo pipefail

KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
    echo "用法: bash sync.sh <扩展目录>    (如 sample 或 ../extension)" >&2
    exit 1
fi
if [ ! -d "$TARGET" ]; then
    echo "目录不存在: $TARGET" >&2
    exit 1
fi

DEST="$TARGET/kit"
rm -rf "$DEST"
mkdir -p "$DEST"
cp "$KIT_DIR"/lib/*.js "$DEST/"

# 落一张来源便条。@why 有人一定会直接改 kit/ 下的文件——那份改动下次同步就没了,
# 而且不会有任何提示。把话写在他会打开的地方。
cat > "$DEST/README.md" <<EOF
# kit（同步产物，别改）

由 \`client/extension-kit/sync.sh\` 从 \`client/extension-kit/lib/\` 复制而来,
**下次同步整目录覆盖**——在这里的改动会消失且没有提示。

要改行为:改 \`client/extension-kit/lib/\`(那是 [Solo] 只读区,属框架级改动,
按 CLAUDE.md 的规矩走反馈),或在你自己的代码里包一层。

同步命令: \`bash client/extension-kit/sync.sh <本扩展目录>\`
EOF

echo "✓ kit → $DEST ($(ls -1 "$DEST"/*.js | wc -l | tr -d ' ') 个模块)"
