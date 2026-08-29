# docs/paper/ — 论文工作区

> 2026-08-24 建。本目录文件：
>
> - [`draft-pattern-first.md`](./draft-pattern-first.md) — **定稿候选 v1.0**（2026-08-29 定夺：模式先行结构胜出）：§2 纯模式（frame/payload 边界 + **五要求 R1–R5** + 利/弊两节账单 + **§2.5 能力门槛** + Figure 1/2 SVG）→ §3 SOLO 作为其一实现（附要求→机制对照表）→ §4 证据（各小节标注回验 §2 哪条主张）。数据冻结窗口 2026-06-14 → 08-24（v1.1.0→v1.2.2），此后的发版刻意不计入。引用已按正文首现顺序重编为 [1]–[26] 并补齐作者/URL（⚠️ 与 v0.1 的旧编号**不再同源**）
> - [`figures/`](./figures/) — Figure 1（箱子解剖）/ Figure 2（上收环）的 SVG 真身（2026-08-29 起替代文内 ASCII 图）；同名 PNG（2x）是给 PDF 构建用的（本机 pyexpat 损坏致 weasyprint 吃不下 SVG）
> - [`build-pdf.sh`](./build-pdf.sh) → `container-model-preprint-v1.pdf` — 正式版 PDF 构建脚本与产物（标题块含署名，剥 draft 头注；23 页）
> - [`archive/draft-human-ai-container.md`](./archive/draft-human-ai-container.md) — 初稿 v0.1（实现穿插结构，2026-08-29 落选归档，只留作历史对照，不再维护）
> - [`publishing-channels.md`](./publishing-channels.md) — 发布渠道对比与推荐路径（中文）
> - [`feedback/`](./feedback/) — 外部评审意见：`chatgtp.md` · `gemini.md`（2026-08-28 收到，已 triage，见状态清单）· `feedback-history.md`（早期 Gemini 事实核查）
> - 本文 — 审阅指南：论文说了什么、每条主张的证据在哪、哪些必须由你亲自核实

## 一、论文的骨架（30 秒版）

- **命题**：AI 辅助开发规模化的头号风险是「每个 AI 各自发明一套约定」；解法不是更好的 prompt，而是**有后果的标准**——只读区升级即覆盖（集装箱逻辑：价值来自不变）+ 反馈上收演进 + 每轮加载的 AI 治理文档。
- **单位**（2026-08-26 修订）：组织单位是**箱子**（标准化技术栈 + 人类归属），**不是「1人1AI」配对**——一个箱子可以 n 人 n AI（user 服务本就多账号，AI 入口有交互会话/定时采集/sentinel/经 system.guide 与 MCP 进来的外部 agent），一个人也可以拥有多个箱子（现状：多数箱子同一运营者）。**人数下界是 0**（2026-08-27 补）：自动化角色的箱子（定时采集、事件响应）日常可以完全无人；唯一不为零的是**归属人**——每个箱子都有可问责的人类 owner，哪怕 owner 从不出现在日常运行里（这条保住了与 all-AI company 的划界）。模型钉死的是边界与归属，不是人头数。
- **档位**：experience report（经验报告），不是理论论文——卖点是真数据，全部主张锚在仓库可查的产出物上（feedback 文档、CHANGELOG、tag）。
- **结构**（v0.2）：§2 纯模式（边界 + **五要求 R1–R5** + 利弊账单 + 能力门槛）→ §3 SOLO 怎么实现（只读区/divergence 检测/autocheck 钩子/双反馈通道/CLAUDE.md）→ §4 证据（21 发版、31 篇反馈 23 篇 triage、三条 feedback→release 追踪案例、5/5 自然实验、非程序员铺栈案例）→ §5 六条 lessons → §6 相关工作七条线 + 对比矩阵 Table 3 → §7 效度威胁（单组织、n 小、无对照、作者=运营者，全认账）。
- **目标投递**：CHASE / CAIN / FORGE / ICSE-SEIP 经验报告档；渠道路线见 `publishing-channels.md` §四。

## 二、🔴 必须由你核实/定夺的（我无法替你确认）

1. ~~**作者署名与身份**~~ → ✅ 2026-08-29 定："Zhongqiang Fu (independent)"，不挂机构。
2. ~~**公开性红线**~~ → ✅ 2026-08-29 定：codename 全部匿名化为 **Projects A–G**（映射按原字母序：
   A=colony · B=finance · C=ladder · D=overview · E=runner · F=trend · G=wavely/erp，**此映射只留在
   本 README，不进论文**）。⚠️ 已知残余：公开的 feedback 语料保留项目原名，论文 Data Availability
   节已如实声明匿名化是 presentational 而非 cryptographic。
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

> ⚠️ 本节及 §五 历史条目里的 [n] 引用编号是 v0.1 旧编号；2026-08-29 定稿候选已按正文首现顺序
> 重编为 [1]–[26]，对号请直接看 `draft-pattern-first.md` 文末 References。

1. ~~引用 [17] 占位~~ → 已核对：K.-J. Stol and B. Fitzgerald, "Inner Source — Adopting Open Source Development Practices in Organizations: A Tutorial," *IEEE Software*, 32(4), pp. 60–67, 2015. (doi: **10.1109/MS.2014.77**——Gemini 反馈给的 2015.100 是错的，已对 ACM DL 核实)。
2. **[15][16][20][24] 是业界来源**（博客/公开帖/工具站）——经验报告档可接受；[20]（Yegge 2011
   记录 Bezos mandate）已在文内注明「原始备忘录不可得」，这是该典故的标准引法。
3. 相关工作里 end-user programming 只引了 Ko 2011，可补 LLM 时代的新文献（如 malleable software 一线）。
4. 目前是 markdown，投稿要转 LaTeX（会议模板：ACM 用 acmart，IEEE 用 IEEEtran——看中哪个会再转）。
5. 字数：v0.2 正文 **7462 词**（含 3 表 2 图，LaTeX 下这部分不按 word 折算篇幅）。CHASE 短文档（4–6 页）要大砍，长文档（10 页）偏满——定了 venue 再裁。
6. ~~摘要偏长~~ → 2026-08-28 已压到 **250 词**（v0.2）；若目标会限 150–200 还要再砍。
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
- [x] **外部评审 triage + 落地（2026-08-28）**：ChatGPT / Gemini 两份意见分类吸收，v0.2 六处实质改动——
      ① **§6 Table 3 对比矩阵**（7 行 × 6 轴，治「旧概念换名字」的拒稿风险；⚠️ 未照抄 ChatGPT 原表：
      它把 Container Model 的 "Federated" 填 `Yes`，与 §4.5「bridge mesh 未部署」自相矛盾，已改为
      "By design (R4); intra-box only today"）；
      ② **§4.1 Table 2 反馈环实测指标**（全部从 git 历史现算、可审计：报告→triage **中位 2 天**
      n=21/23 范围 1–19、14/23 被发版说明按文件名引用（下界）、7 箱中 6 箱提过报告、最活跃单箱占
      15/28）+ 两条诚实注脚（2 篇生在 done/ 无前史、triage 成批而非匀速）；
      ③ **新增 R5「资源归属必须被证明」**（四要求 → 五要求，全文编号同步）——补的是 R1–R4 的真空：
      §4.1 的 Redis 撞库事故正落在这里，而 §2.5 的爆破半径论证本来靠这条不存在的要求撑着；
      §3.6 挂上现成机制（run.sh 归属校验 + 前端端口 fail-fast，代码核过）；
      ④ **`mutual intelligibility` 降级为「argued, not measured」**：§2.3 引子不再声称「每条都有实测」、
      该条明标未实测并给出间接证据与「下一个该做的实验」、§7 增威胁条、§8 结论口径同步；
      ⑤ **Figure 1/2**（箱子解剖 + 五要求各自生效的时刻；R2 上收环）——等宽图形态，LaTeX 化时按图注转 TikZ；
      ⑥ **摘要 283 → 250 词**，并塞进 §2.5 的 why-now；另补 §2 开篇「原则=enforced invariance，
      集装箱=比喻」层次句（ChatGPT 第 4 点打折吸收：保留标题不改）、§2.4 补 §4 锚点、
      Contribution 1 补能力门槛、§7 另增「证据来源偏斜」「能力门槛不可证伪」两条威胁、三张表编号统一。
      **未吸收**：R4 别过度宣称（已做到）· LaTeX/页数（README 早有）· 评分与会议匹配表（无动作项）。
      **压后**：双盲匿名化、原始文本摘录（与匿名化冲突，等定 venue）。
      正文 5976 → 7462 词（表/图占其中一部分，LaTeX 排版下不按 word 计篇幅）
- [x] v0.2 §4.2 加段（2026-08-28，用户提出）：**版本偏差不破坏通讯 = 不变买回来的灵活性**——wire 契约在 frame 里、v1.x 加性演进，箱子自选升级时机而不失去被调用的能力（与 §6 ERP 升级瘫痪互文）；窗口内唯一例外 v1.1.17 user.register BREAKING 有 v1.1.12 起的 upgrade.sh 横幅机制托底（两个时间点已核：横幅先于例外存在）。注：无版本协商机制，兼容靠纪律，此点已如实措辞
- [x] **结构定夺（2026-08-29）：v0.2 模式先行胜出**，升为定稿候选 v1.0；v0.1 移入 `archive/`
- [x] 定稿前收尾（2026-08-29）：13 services 事实纠错（services.json 实数 14 含 router）、[12] ATSA 作者纠错（Q. Zhang → Q. Gao，arXiv API 核实）、14 条 arXiv ID 全部验真、缺作者的 10 条引用补齐、业界引源补 URL、引用按首现顺序重编 [1]–[26]、ASCII 图 → `figures/*.svg`、加 Data Availability 节（repo 公开地址）、若干措辞修正（head risk→principal risk 等）
- [ ] 你的事实核查（§二、§三 其余项）
- [x] 署名 + 匿名化 + 正式版 PDF（2026-08-29）：署名 Zhongqiang Fu；codename → Projects A–G
      （映射见 §二.2）；`build-pdf.sh` 产出 `container-model-preprint-v1.pdf`（23 页，图表渲染已目检）
- [ ] 定 venue（CFP 现查 preprint 政策）
- [ ] 预印本发布（发布动作，等你明确说发才发）——🔴 渠道现实（2026-08-29 现查）：TechRxiv 停收
      （2026-08-27 确认）、**OSF 通用服务器 2025-08-25 起也停收**（本轮核实，备胎作废）⇒ 唯一即时
      可发 = **Zenodo**（已注册；不可检索，占 DOI 存档位），TechRxiv 恢复后补挂可检索版，详见
      `publishing-channels.md` §四修订版
- [ ] LaTeX 化 + 裁字数
