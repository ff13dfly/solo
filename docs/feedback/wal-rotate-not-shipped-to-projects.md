# 反馈：`wal-rotate.sh` 没进 scaffold —— CHANGELOG 让下游挂上它，下游却拿不到它

> 来源：finance 会话，2026-08-30（刚把 bundle 从 v1.2.8 升到 v1.2.11）。场景：升级后
> 立刻做了一轮导入压测，量到新的 WAL 归档一天写出 **623,773 行 / 295MB**，于是照
> CHANGELOG 的建议去挂轮转脚本——**在项目里找不到这个文件**。
>
> **依据分两类**：
> - **自查实测**（finance-dev，2026-08-30）：`upgrade.sh` 第 301 行的脚本清单、
>   两侧目录 `ls`、以及升级后 finance 侧 `deploy/` 的实际内容；归档体积是压测实测值。
> - **判断**：§三 的三个选项与取舍。
>
> 涉及：`deploy/scaffold/upgrade.sh:301`、`deploy/wal-rotate.sh` 的存放位置；
> 间接涉及 v1.2.9 CHANGELOG 那条「建议给长期运行的栈挂上」的可执行性。

---

## 一、【实测】建议与可得性对不上

v1.2.9 的 CHANGELOG 在 WAL 归档那节末尾写：

> 建议给长期运行的栈挂上 `deploy/wal-rotate.sh`（Linux 用 systemd timer；
> 🔴 macOS 别用 cron/launchd，TCC 会静默拦掉）。

但这个文件只存在于 **Solo 源码仓自己的 `deploy/`**：

```
solo/deploy/wal-rotate.sh              存在
solo/deploy/scaffold/wal-rotate.sh     不存在   ← upgrade/init 只从 scaffold/ 下发
finance/deploy/wal-rotate.sh           不存在   ← 升级到 v1.2.11 之后仍然没有
```

而 `upgrade.sh:301` 的 [Solo→Project] 脚本清单是写死的六个：

```bash
for s in run.sh precheck.sh admin-up.sh doctor.sh seed-registry.js migrate-cursor-index.js; do
```

⇒ 派生项目升到 v1.2.9+ 后，**归档行为已经变了（这是好事），但配套的运维脚本一个字节
都没跟过去**。下游看着 CHANGELOG 里的路径去找，只会得到 `No such file`——
然后大概率自己写一个，或者干脆不轮转。

## 二、【实测】这不是个可以放着不管的量

finance 升级当天的一轮导入压测（三个量级共约 62 万次实体写入）：

| 指标 | 实测 |
|---|---|
| 归档行数 | 623,773 行（与操作数精确吻合，**审计完整性 100%**——v1.2.9 的修复确实生效） |
| 落盘体积 | `2026-08-30.log` **295MB** + `.index` 73MB |
| 每行成本 | 约 500 字节（含索引） |

**先说清楚：这组数字是给「体积增速」定标的，不是在抱怨归档写太多。**
v1.2.9 之前这些条目会被 `MAXLEN` 静默丢掉，现在一条不少地落盘，正是那次修复的目的。
问题只在于：归档**只增不删**是设计，那么「怎么删」就必须和「开始不丢」一起到位。
finance 的生产机是 30G 盘、954MB 内存，与 Redis 持久化、pm2 日志同盘——
CHANGELOG 自己也写了「满盘会拖垮整栈」，还为此加了 `archiver.disk.low/critical` 告警。
**告警下发了，止血的工具没下发**：下游只会先收到告警，然后发现手上没有那把扳手。

## 三、【建议】按代价排序

1. **把 `wal-rotate.sh` 挪进 `deploy/scaffold/` 并加进 `upgrade.sh:301` 的清单**（最小改动）。
   它已经带 `--dry-run`、不删只压缩（gzip 实测 13:1）、冷存与 RDB 快照都是可选项，
   本身就是按「给别人用」写的。进了清单还能白拿 DIVERGED 检测——项目改过就 staged 成
   `.new`，不会被覆盖。
2. **顺带在脚本头注里写死「挂哪儿」**。现在 CHANGELOG 说了 systemd timer 与 macOS 的坑，
   但脚本自己没说。下游拿到文件后还要回去翻 CHANGELOG 才知道怎么挂，
   而 CHANGELOG 是按版本组织的、三个版本后就不好找了。
3. **（可选）让 `archiver.disk.low` 的告警文案带上轮转脚本的路径**。
   告警响的那一刻正是最需要那把扳手的时刻，而那时人多半在别的上下文里。

## 四、处理结论

（待 triage）
