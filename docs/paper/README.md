# docs/paper/ — 论文工作区

> 2026-08-24 建。本目录三份文件：
>
> - [`draft-human-ai-container.md`](./draft-human-ai-container.md) — 论文初稿 v0.1（英文，经验报告档；SOLO 穿插在模式叙述里）
> - [`draft-pattern-first.md`](./draft-pattern-first.md) — **重构稿 v0.2**（2026-08-27，用户要求「先模式后实现」）：§2 纯模式（frame/payload 边界 + 四要求 R1–R4 + 利/弊两节账单 + **§2.5 能力门槛**，零实现词汇）→ §3 SOLO 作为其一实现（附要求→机制对照表）→ §4 证据（各小节标注回验 §2 哪条主张）。证据与引用编号与 v0.1 同源；§7 新增「单一实现」威胁。**二选一定稿后废弃另一份**
> - [`publishing-channels.md`](./publishing-channels.md) — 发布渠道对比与推荐路径（中文）
> - 本文 — 审阅指南：论文说了什么、每条主张的证据在哪、哪些必须由你亲自核实

## 一、论文的骨架（30 秒版）

- **命题**：AI 辅助开发规模化的头号风险是「每个 AI 各自发明一套约定」；解法不是更好的 prompt，而是**有后果的标准**——只读区升级即覆盖（集装箱逻辑：价值来自不变）+ 反馈上收演进 + 每轮加载的 AI 治理文档。
- **单位**（2026-08-26 修订）：组织单位是**箱子**（标准化技术栈 + 人类归属），**不是「1人1AI」配对**——一个箱子可以 n 人 n AI（user 服务本就多账号，AI 入口有交互会话/定时采集/sentinel/经 system.guide 与 MCP 进来的外部 agent），一个人也可以拥有多个箱子（现状：多数箱子同一运营者）。**人数下界是 0**（2026-08-27 补）：自动化角色的箱子（定时采集、事件响应）日常可以完全无人；唯一不为零的是**归属人**——每个箱子都有可问责的人类 owner，哪怕 owner 从不出现在日常运行里（这条保住了与 all-AI company 的划界）。模型钉死的是边界与归属，不是人头数。
- **档位**：experience report（经验报告），不是理论论文——卖点是真数据，全部主张锚在仓库可查的产出物上（feedback 文档、CHANGELOG、tag）。
- **结构**：§2 模式四原则 → §3 SOLO 怎么实现（只读区/divergence 检测/autocheck 钩子/双反馈通道/CLAUDE.md）→ §4 证据（21 发版、31 篇反馈 23 篇 triage、三条 feedback→release 追踪案例、5/5 自然实验、非程序员铺栈案例）→ §5 六条 lessons → §6 相关工作四条线 → §7 效度威胁（单组织、n 小、无对照、作者=运营者，全认账）。
- **目标投递**：CHASE / CAIN / FORGE / ICSE-SEIP 经验报告档；渠道路线见 `publishing-channels.md` §四。

## 二、🔴 必须由你核实/定夺的（我无法替你确认）

1. **作者署名与身份**：现在是占位 "Fuu (independent)"。用真名还是笔名、要不要挂机构，投稿前定。
2. **公开性红线**：论文点名了 7 个派生项目 codename（colony/finance/ladder/overview/runner/trend/wavely-erp）和「给无终端经验的市场同事铺栈」案例（§4.4）。**mso 是客户生产、finance 在别人服务器上**——这些描述是否可以公开、codename 要不要匿名化（Project A–G），你判断。
3. **时间线**：我把可考窗口定为 **2026-06-14（v1.1.0 tag）→ 2026-08-24，约十周**；公开仓库首提交 2026-07-06。SOLO 实际开发起点更早（VERSION.md 拍板 2026-06-11，之前应该还有 v1.0 阶段）——**真实起点你补**，补上后 §4 Setting 和摘要里的时长措辞可以放宽。
4. **§4.5 的「未证实清单」**：我写了 bridge mesh「designed and adversarially reviewed but not deployed」——依据是 VERSION.v2.md 草案与 org-container feedback 里提到的 §3.6 安全评审。**v2 现状以你为准**，如已有进展要改。
5. **发布本身**：任何渠道（TechRxiv 也算）都是对外发布，且论文附带公开了 SOLO 的架构细节与运营拓扑的一部分。发不发、何时发，你拍板。

## 三、主张 → 证据对照表（审阅时抽查用）

| 论文主张 | 证据落点 | 核实方式 |
|---|---|---|
| 21 个 tag（v1.1.0→v1.2.2，06-14→08-24） | git tag | `git for-each-ref --sort=creatordate refs/tags` |
| 31 篇反馈、23 篇已 triage | `docs/feedback/` + `done/` | `ls docs/feedback/*.md docs/feedback/done/ \| wc` |
| guide 机制 ← wavely 反馈 → v1.1.11 | `done/ai-agent-self-describing-api.md`；feedback README 明写 | 读那篇的「处理结论」 |
| redis 端口归属静默失败 → v1.1.14 修 | `done/redis-port-ownership.md`；CHANGELOG v1.1.14 节（L545） | 对读两处 |
| v1.1.16 收口六篇 / v1.1.17 收口五篇（colony） | CHANGELOG L386 / L321 | 已核对版本头归属无误 |
| 5/5 派生项目自补 CLAUDE.md | `docs/feedback/org-container-per-person-mesh.md` §一 | 该篇标注为自查实测 |
| 「Router 如实返回 blocked 计数、ingress 丢弃」二手依据纠偏案例 | `done/inherited-router-url-silent-misdelivery.md` (L72-74)；CHANGELOG v1.1.15 (L502-506) | 已定位核实（原 ⚠️ 已解） |
| bundle 版本跨度 v1.0.0–v1.1.15（08-15 快照） | 全局 CLAUDE.md 实扫记录 | 各项目 `cat .solo-version` 现扫一遍更稳 |
| 非程序员铺栈案例（promo） | org-container feedback §四 | 该篇标注为本轮实测 |
| 14 个服务 | `deploy/services.json` | 已核（14） |
| system.report 匿名通道、1000 条裁旧、去重计数 | `docs/feedback/README.md` 通道 1 | 已核 |

## 四、初稿的已知弱点（改稿方向）

1. ~~引用 [17] 占位~~ → 已核对：K.-J. Stol and B. Fitzgerald, "Inner Source — Adopting Open Source Development Practices in Organizations: A Tutorial," *IEEE Software*, 32(4), pp. 60–67, 2015. (doi: **10.1109/MS.2014.77**——Gemini 反馈给的 2015.100 是错的，已对 ACM DL 核实)。
2. **[15][16][20][24] 是业界来源**（博客/公开帖/工具站）——经验报告档可接受；[20]（Yegge 2011
   记录 Bezos mandate）已在文内注明「原始备忘录不可得」，这是该典故的标准引法。
3. 相关工作里 end-user programming 只引了 Ko 2011，可补 LLM 时代的新文献（如 malleable software 一线）。
4. 目前是 markdown，投稿要转 LaTeX（会议模板：ACM 用 acmart，IEEE 用 IEEEtran——看中哪个会再转）。
5. 字数约 4800 词，CHASE 短文档（4–6 页）要砍，长文档（10 页）有余量——定了 venue 再裁。
6. 摘要偏长（~250 词），多数会限 150–250。
7. **抄袭/诚信审查结论（2026-08-24）**：严格抄袭——无（数据一手、类比已引 Levinson、
   借用思想均署名；集装箱类比出处 = 自家 2026-08-20 overview 会话，git 可证）。
   三个待办 **2026-08-24 已处理**：
   ① ~~系统相关工作扫描~~ → 精读了 arXiv:2603.14805（Yahoo 单组织部署、AKU 知识图谱、
   只标准化知识 schema 不标准化栈、无单元归属/无强制不变/无上收协议——划界已写进 §6）；
   并**新发现一整条相关工作线**：AGENTS.md/CLAUDE.md 上下文文件实证研究
   （arXiv:2511.12884 大规模刻画 2303 份文件、arXiv:2509.14744、arXiv:2602.11988 任务
   成功率评测结果混合），已作为 §6 "Agent context files" 段引入并划界（它们测的是任务级
   技术上下文，我们的 5/5 观察是组织级治理内容——互补不重叠）。残余：投稿前仍应过一遍
   近两年 CHASE/CSCW/CAIN 论文集标题。
   ② ~~补引思想前身~~ → 已入文：Haier rendanheyi = Hamel & Zanini, HBR 2018-11 [19]（已核）；
   Bezos mandate = Yegge 2011 公开帖 [20]（已核：原始备忘录失传，Yegge 帖是标准引source）；
   cruft/copier 模板漂移检测工具 [24]（已核）+ node_modules 覆盖语义，写进 §3.2 结尾
   并明说「我们是刻意站在这些机制上，把便利语义重构为治理边界」。
   ③ ~~AI 写作声明~~ → 已加 "Acknowledgments and AI Disclosure" 节（References 前）：
   AI 起草、作者审定并对内容负全责、按 ACM/IEEE 政策披露。
   另：§3.5 措辞不许收紧——CLAUDE.md 每轮加载是 Claude Code 产品特性，论文只主张
   per-turn vs per-edit 的治理区分与 5/5 证据，不主张机制发明权。

## 五、状态

- [x] 初稿 v0.1（2026-08-24）
- [x] 诚信三待办：相关工作划界（含 agent context files 新线）/ 思想前身补引 / AI 写作声明（2026-08-24，见 §四.7）
- [x] Gemini 事实核查反馈（`feedback.md`）处理完毕（2026-08-24 深夜）：refs 元数据补全（DOI 纠错见 §四.1）、§4 改 7+1 表述、§4.5 回填 bridge 最新进展、README 行号/出处已由核查方回填
- [x] 单位定义修订（2026-08-26，用户指出与事实不符）：「1人1AI pair」→「箱子 = 单位，n 人 n AI」。标题从 "One Human, One AI, One Container" 改为 "The Container Model"；§2.1 重写；摘要/§1 四原则/§4 Setting/§6 划界/结论/致谢共 20+ 处 pair 措辞同步清理。§4 Setting 补了实际构成（多数箱子同一运营者、单箱多 AI actor、§4.4 箱两位人类分饰铺设/运营）
- [x] 补遗（2026-08-27）：①清理 6 处泛指单数残留（"the AI's editing loop" 等）；②明确**人数下界为 0**——自动化角色的箱子日常可无人、不为零的只有归属人（摘要/§1 原则一/§2.1/§4 Setting 同步；与 all-AI company 的划界句改为「每个节点向真实人类问责」）
- [x] 重构稿 v0.2 `draft-pattern-first.md`（2026-08-27）：模式先行结构，见文首文件清单的说明
- [x] v0.2 §6 增「Enterprise platforms: ERP flexibility and product lines」段（2026-08-27，用户提出）：ERP 升级瘫痪 = 可改核心的历史反例；SAP clean core（"扩展不破升级、升级不破扩展"）= R1 的工业先驱，§3.2 先例清单同步挂 [25]；三轴划界——粒度（每角色整栈 vs 企业单体）、**灵活性的种类（ERP = 预设变异点/配置旋钮，箱子 payload = 开放变异，靠 AI 时代门禁才变得可治理，挂 §2.5）**、演进环（厂商黑箱管道 vs 库内可读的溯源 triage）；顺带点明七箱之一本身就是标准 frame 上长出的小 ERP。新引 [25]（SAP 官方，业界引源已核：news.sap.com/SAP Community 2023–2025）、[26]（Clements & Northrop, Software Product Lines, Addison-Wesley 2001，经典教材）。只加在 v0.2
- [x] v0.2 增补 §2.5「Why now: 能力门槛」（2026-08-27，用户提出）：论证模式只在 AI 能力过阈值后才有意义，且论证是双面的——同一能力使箱子**可负担**（一箱之组能填满整栈、标准由 AI 消费故上手成本趋零）又使箱子**必要**（AI 速度的漂移 + 建设能力=破坏能力 ⇒ 必须限制爆破面：R1 不可改 frame、R4 出箱必中介、R3 出码前治理，最坏损失=一箱 payload）；集装箱史同构（散货手工装卸年代标准箱无经济意义，集装箱是给机器定尺寸的货）；推论=模式价值随模型能力上升而增（与 §7 timeline 威胁互挂）。原 §2.5 Scope 顺延为 §2.6。**只加在 v0.2**，若定夺选 v0.1 再移植
- [ ] **结构定夺：v0.1（实现穿插）vs v0.2（模式先行）二选一**，定稿后删另一份，用户审阅中
- [ ] 你的事实核查（§二、§三 其余项）
- [ ] 定 venue（CFP 现查 preprint 政策）
- [ ] TechRxiv 占位（发布动作，等你明确说发才发）——🔴 2026-08-27：TechRxiv 平台迁移中**暂停收投稿**（用户截图实测，详见 `publishing-channels.md` TechRxiv 节），被动等待；备胎 OSF
- [ ] LaTeX 化 + 裁字数
