# 反馈：`init.sh` 生成 `.env` 的 heredoc 没 quote，注释里的反引号被当命令执行

> 来源：colony 派生项目（trade 的 ant 引擎迁移），2026-08-09 首次 scaffold 时撞到。
> 依据：**本机实测**（solo v1.1.15，macOS bash 3.2）+ 可复现的最小片段（见第二节）。
> 涉及：`deploy/scaffold/init.sh:344`（heredoc 开头）、`:409`（含反引号的注释行）。
> 影响面：**每一个新 scaffold 的项目**，无条件触发。
>
> 一句话：一对反斜杠的事，但它在 `init.sh` 的输出里插了一行 `command not found`，
> 而**退出码是 0**——`set -euo pipefail` 拦不住，第一次建项目的人无从判断这行要不要紧。

---

## 一、实测现象

`bash deploy/scaffold/init.sh colony` 的输出中间夹着一行：

```
✓ Redis port: 6384 (auto-selected, not currently in use)
/Users/fuu/Desktop/AI/solo/deploy/scaffold/init.sh: line 344: HXxxxx: command not found
✓ Created: .env
```

scaffold 随后一路正常走完（`✓ Scaffold ready`），退出码 0。

生成的 `.env` 里，对应那行注释**少了一截**：

```diff
- # Twilio（providerCode = Content SID `HXxxxx`；模版实体建议同时声明 variableOrder，
+ # Twilio（providerCode = Content SID ；模版实体建议同时声明 variableOrder，
```

## 二、根因与复现

`init.sh:344` 用的是**未加引号**的 heredoc：

```bash
cat > "$NEW_DIR/.env" << EOF
```

未 quote 的 heredoc 会做参数展开**和命令替换**。而 `:409` 是一行中文注释，里面用反引号标注
Twilio 的 Content SID 示例值：

```
# Twilio（providerCode = Content SID `HXxxxx`；模版实体建议同时声明 variableOrder，
```

于是 bash 把 `` `HXxxxx` `` 当命令替换执行 → 报 `command not found` → 替换结果为空串写进 `.env`。

复现（bash，两行即可）：

```bash
bash -c 'cat << EOF
# Content SID `HXxxxx`
EOF'
# → bash: HXxxxx: command not found
# → # Content SID
```

**关键细节：这个失败的退出码是 0。**

```bash
bash -c 'cat << EOF > /dev/null
`HXxxxx`
EOF'; echo "exit=$?"     # → exit=0
```

命令替换失败不会让 `cat` 失败，所以 `set -euo pipefail` 完全不介入，脚本继续跑到底。
这正是它能长期存在而没人处理的原因——**它只在肉眼可见的日志里制造噪音，在任何自动化
判据下都是"成功"**。

## 三、建议

1. **转义那对反引号**（最小改动，`:409`）：

   ```diff
   - # Twilio（providerCode = Content SID `HXxxxx`；模版实体建议同时声明 variableOrder，
   + # Twilio（providerCode = Content SID \`HXxxxx\`；模版实体建议同时声明 variableOrder，
   ```

   实测（第二节的片段加上反斜杠）：反引号原样落进 `.env`，报错消失。

   ⚠️ **不能简单把 `<< EOF` 改成 `<< 'EOF'`** —— 这份 heredoc 里有大量**故意**要展开的插值
   （`$REDIS_PASSWORD`、`$JWT_SECRET`、`$ROUTER_PUBLIC_KEY`、`$PROJECT_NAME`、三个前端端口……），
   quote 掉会把它们全部写成字面量，那是比现在严重得多的故障。

2. **给这份 heredoc 加一条守则**（注释写在 `:344` 上方即可）：模板正文里凡是要出现
   反引号或 `$(...)` 的地方一律转义。这份文件的注释密度很高（SMTP / SMS / Twilio /
   Resend 的示例值），后面再加一段带反引号的说明，会以同样的形态复发。

3. **（可选）加一道自检**：`init.sh` 末尾对生成的 `.env` 做一次 `grep -c '^\s*[A-Z_]*='`
   之类的数量校验，或干脆在脚本里 `set -o errtrace` + `trap` 把 stderr 里的
   `command not found` 升级成硬失败。优先级低于前两条——根因修掉后这条只是防复发。

## 四、为什么值得改

单看是一行无害的注释被吞。但它出现在**每个人接触 Solo 的第一分钟**：`init.sh` 是派生项目的
入口动作，输出里突然插一行红色的 `command not found`，而前后都是绿色的 `✓`。

第一次建项目的人没有基线可比，只能停下来排查——而排查路径并不短：要读 `init.sh`、要认出
未 quote 的 heredoc、要定位到 65 行之外的那个反引号，才能确认「这行可以忽略」。本次实际
花掉的正是这段时间。

这与 `redis-port-ownership.md`、`scaffold-startup-guards-fallout.md` 是同一族问题：
**脚本在"成功"的退出码下做了一件没做成的事**。区别只在这次的后果轻（丢一段注释），
所以更该顺手修掉——它不值得任何人再排查第二遍。

---

## 处理结论（solo 侧）

实测属实，已修复（2026-08-10）：转义 `:409` 那对反引号（建议 1），并在 heredoc 开头（`:344` 上方）加了一段守则注释，说明这份 heredoc 为什么必须保持 unquoted、以及后面再写反引号/`$(...)` 时要转义（建议 2）。建议 3（自检）没做——建议 1 落地后没有已知的复发路径，属于建议里"防复发"的可选项，暂不加。

验证：`bash deploy/scaffold/init.sh test-colony-fix <scratch-dir>` 完整跑过一次，输出里没有再出现 `command not found`，生成的 `.env` 里 Twilio 那行反引号原样落地（`grep -n Twilio .env` 核对过）。
