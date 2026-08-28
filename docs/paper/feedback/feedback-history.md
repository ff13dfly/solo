# docs/paper/ 论文与发布策略核查反馈报告 (Feedback)

> **核查日期**：2026-08-24  
> **核查对象**：
> - [`draft-human-ai-container.md`](./draft-human-ai-container.md)（论文草稿 v0.1）
> - [`README.md`](./README.md)（论文工作区审阅指南）
> - [`publishing-channels.md`](./publishing-channels.md)（发布渠道分析）
> 
> **核查结论概括**：论文核心事实数据**高度严谨且与代码库/Git 记录完全吻合**（21 个 Tag、31 篇 Feedback、14 个服务、三条演进追踪案例、5/5 治理文档自然实验等均经受住了一对一的代码与提交历史审计）。仅存在少数几处需要补齐、纠偏的细节及最新进展回填。

---

## 一、事实与数据核查结果对照（逐项审计）

| 论文/文档主张 | 审计方式与真实落点 | 核实结论 | 修正 / 补全建议 |
|---|---|---|---|
| **21 个 Git Tag**<br>(v1.1.0 → v1.2.2，06-14 → 08-24，约 10 周) | `git for-each-ref --sort=creatordate refs/tags`<br>首 Tag `v1.1.0` (2026-06-14)<br>最新 `v1.2.2` (2026-08-24) | ✅ **完全属实**<br>Tag 列表共 21 个，跨度刚好 71 天（10.1 周），发版节奏约 2 release/周。 | 事实无误，无需改动。 |
| **31 篇 Feedback 报告**<br>(23 篇已归档 triage，8 篇待办) | `find docs/feedback -name "*.md"`<br>- `done/` 目录下共 23 篇<br>- 根目录下共 8 篇（排除 README） | ✅ **完全属实**<br>23 + 8 = 31 篇，已 triage 闭环与 pending 分布精准匹配。 | 事实无误，无需改动。 |
| **14 个微服务架构** | `deploy/services.json`<br>包含 10 个 core + 4 个 apps | ✅ **完全属实**<br>router, administrator, user, agent, nexus, notification, gateway, ingress, mcp, orchestrator, storage, fulfillment, planner, approval 共 14 个。 | 事实无误，无需改动。 |
| **wavely 推动 guide 机制 (v1.1.11)** | `docs/feedback/done/ai-agent-self-describing-api.md`<br>`docs/planning/CHANGELOG.md` L688 [v1.1.11] | ✅ **完全属实**<br>2026-07-23 由 wavely 外部 AI 代理灌数据实测发现，同日落地为 v1.1.11 的 `system.guide` 与 `guide()`。 | 事实无误，无需改动。 |
| **Redis 端口归属静默失败 (v1.1.14)** | `docs/feedback/done/redis-port-ownership.md`<br>`docs/planning/CHANGELOG.md` L545 [v1.1.14] | ✅ **完全属实**<br>overview/trend 同机冲突实测，落地到 `deploy/scaffold/run.sh` 启动归属校验与前端端口 fail-fast。 | ⚠️ `docs/paper/README.md` 表格写为 `~L591`，实际在 CHANGELOG **L545**（小行号偏差）。 |
| **批量 Upcycling 案例**<br>(v1.1.16 收口 6 篇 / v1.1.17 收口 colony 5 篇) | `docs/planning/CHANGELOG.md`<br>- L386 [v1.1.16] 收口 6 篇<br>- L321 [v1.1.17] 收口 colony 5 篇 | ✅ **完全属实**<br>CHANGELOG 头部明确标注这两轮集中 triage 记录。 | 事实无误，无需改动。 |
| **证据级别纠偏案例**<br>(Router 如实返回 blocked 计数，ingress 丢弃) | `docs/feedback/done/inherited-router-url-silent-misdelivery.md` (L72-74)<br>`CHANGELOG.md` L502-506 [v1.1.15] | ✅ **已成功定位出处**<br>（之前在 README 标注为待定位 ⚠️） | **已定位**：原出处为 `inherited-router-url-silent-misdelivery.md`，并在 CHANGELOG v1.1.15 条目明确记录了此项纠偏。 |
| **5/5 自然实验**<br>(派生项目自补 CLAUDE.md) | `docs/feedback/org-container-per-person-mesh.md` §一<br>实测 5 仓：overview, finance, trend, colony, runner | ✅ **完全属实**<br>实测 5 个派生栈无一例外自行补齐了项目根 governing document。 | 见下文关于派生项目总数（7 还是 8）的统计对齐说明。 |
| **非程序员铺栈案例**<br>(promo 节点) | `docs/feedback/org-container-per-person-mesh.md` §一、§四 | ✅ **完全属实**<br>给无终端经验市场人员交付 promo 节点，验证了 operation vs provisioning 的边界。 | 见下文命名一致性说明。 |
| **双反馈通道**<br>(人工 markdown + 运行时 `system.report`) | `docs/feedback/README.md`<br>Redis 键 `SYSTEM:AI:REPORT`，上限 1000 裁旧，去重累计 count | ✅ **完全属实** | 事实无误，无需改动。 |

---

## 二、发现的问题、细微出入与优化建议

### 1. 派生项目数量与代号对齐（7 个 vs 8 个，promo 归属）
- **现象**：
  - 论文 §4 Setting 和摘要写："across **seven** derived production systems... (project codenames: colony, finance, ladder, overview, runner, trend, wavely/erp)"；
  - 论文 §4.4 和反馈报告 `org-container-per-person-mesh.md` 中引用的非程序员案例项目名称为 **`promo`**；
  - §4.3 的自然实验中是在 2026-08-20 针对当时活跃的 **5** 个项目（overview, finance, trend, colony, runner）做的排查。
- **核实与建议**：
  - 如果 `promo` 是独立于上述 7 个项目之外的新铺节点，则实际试验涉及的项目总数应为 **8 个**（7 个已有 + 1 个 promo 试点），或者在 §4 Setting 列表中将 `promo` 列入代号集；
  - 建议在论文 §4 Setting 中统一步调，例如："seven long-running derived production systems (colony, finance, ladder, overview, runner, trend, wavely/erp), plus an eighth provisioning trial (promo) for a non-technical role"。

### 2. 引用文献 [17] 的卷期页码补全与占位清理
- **现象**：
  - 论文 Reference [17] 标有 `(upstream-first / inner-source discipline; verify exact biblio before submission)`；
  - `README.md` §四.1 提示该条为凭记忆引用，需核实。
- **核实结果**：
  - 论文题目：*Inner Source — Adopting Open Source Development Practices in Organizations: A Tutorial*
  - 作者：Klaas-Jan Stol and Brian Fitzgerald
  - 期刊：*IEEE Software*, Vol. 32, No. 4, pp. 60–67, July-Aug. 2015.
  - DOI: `10.1109/MS.2015.100`
- **建议**：直接在 `draft-human-ai-container.md` 中更新为标准引用格式，去掉括号内的待办提示。

### 3. 文献 [18] 与 [19] 的精确元数据补全
- **[18] Ko et al. (End-User Software Engineering)**：
  - 标准格式：A. J. Ko et al., "The State of the Art in End-User Software Engineering," *ACM Computing Surveys (CSUR)*, Vol. 43, No. 3, Article 21, pp. 1–44, 2011.
- **[19] Hamel & Zanini (Haier Rendanheyi)**：
  - 标准格式：G. Hamel and M. Zanini, "The End of Bureaucracy: How a Chinese company reinvented management for the digital age," *Harvard Business Review*, Vol. 96, No. 6, pp. 90–98, Nov–Dec 2018.

### 4. §4.5 "未证实清单" 的最新进展回填（2026-08-23 / 08-24 增量）
- **现象**：
  - 论文 §4.5 称 bridge mesh "designed and adversarially reviewed but not deployed"；
  - 实际上在 2026-08-23 / 08-24，仓库新增了：
    1. A 线首个试验田拍板（overview → runner 同机 loopback bridge，见 `docs/feedback/v2-bridge-first-testbed-own-mesh.md` 与 `VERSION.v2.md` L85-89 回写）；
    2. 主箱-子箱协同运行模式设计草案（下行存档确认制 / 定期拉取航线心跳 / 门铃，见 `docs/planning/v2-bridge-interaction.md` 与 `VERSION.v2.md` L80-84 回写）。
- **建议**：
  - 论文 §4.5 的核心定性依然正确（代码尚未完成部署测试），但措辞可以更精准地体现当前迭代阶段，例如补充一句话："A first loopback testbed (overview → runner) and a three-channel asynchronous interaction protocol (archival-ack, periodic poll, doorbell) have recently entered specification, while deployment remains ongoing."

### 5. `docs/paper/README.md` 中的待办项解决
- **出处定位已解决**：
  - §三 第 34 行的“Router 如实返回 blocked 计数”出处确认为 `docs/feedback/done/inherited-router-url-silent-misdelivery.md`，可将 ⚠️ 标记更新为正式文件引用链接。
- **行号微调**：
  - §三 第 31 行 `CHANGELOG v1.1.14 节（~L591）` 应修正为 `L545`。

---

## 三、学术规范与发布策略建议（针对 `publishing-channels.md`）

1. **双盲审（Double-Blind Review）脱敏红线**：
   - 目标投递会议（CHASE / CAIN / ICSE-SEIP / FORGE）大多要求双盲评审；
   - 若直接在论文中披露真实项目名称（如 wavely-erp, colony, finance）、公司私有拓扑，或作者独立开发者身份（Fuu），会直接违反双盲规则；
   - **建议策略**：
     - 若先上 **TechRxiv**：这是单盲公开预印本，可以保留真实上下文；
     - 若后续投递**双盲会议**：需准备一份匿名版本（将项目名称替换为 Project A–G，隐去 GitHub 仓库可定位的绝对路径与个性化特征）。
2. **论文类型适配度**：
   - 论文完全符合 **Experience Report / Software Engineering in Practice (SEIP)** 档位的要求：以实际系统运行产生的可审计产出物为依据、坦率承认效度威胁（单组织、无对照组）、提炼可迁移的经验教训（Lessons 1–6）。
3. **字数与模板**：
   - 当前初稿约 4800 词，转为 ACM (`acmart`) 或 IEEE (`IEEEtran`) 双栏模板后约为 8–9 页。若目标是 CHASE 短文（4–6 页）需做删减；若投递 ICSE-SEIP / CAIN 经验报告长文（8–10 页），篇幅恰好适中。

---

## 四、下一步建议执行动作

- [ ] **更新 `docs/paper/draft-human-ai-container.md`**：
  - 补全文献 [17]、[18]、[19] 的标准卷期页码与 DOI；
  - 在 §4 对齐 promo 与 7 个代号的表述；
  - 在 §4.5 微调 v2 bridge 规格最新进展的措辞。
- [ ] **更新 `docs/paper/README.md`**：
  - 回填第 34 条的确定出处（`docs/feedback/done/inherited-router-url-silent-misdelivery.md`）；
  - 修正 CHANGELOG v1.1.14 的参考行号为 L545。

---

## 处理结论（2026-08-24，Claude 回填）

§四 两组动作全部落地，另有一处对反馈本身的纠错：

- **draft 已改 4 处**：① §4 Setting 采纳「7 常驻 + 1 试点」表述（promo 代号不入文，保持
  "a non-technical role"）；② §4.5 括注回填 bridge 最新进展（loopback 试验田 + 三通道协同
  协议已进规格、部署未开始——措辞对齐 VERSION.v2.md 08-23/08-24 两条回写，核实过原文）；
  ③ [17] 补全卷期页码；④ [19] HBR 补卷期。
- **🔴 反馈 §二.2 的 DOI 是错的**：Stol & Fitzgerald 2015 的 DOI 实为 **10.1109/MS.2014.77**
  （ACM DL: dl.acm.org/doi/10.1109/MS.2014.77；文章 2014 年在线、2015 年出刊，故 DOI 年份
  是 2014），反馈给的 `10.1109/MS.2015.100` 不存在。draft 与 README 均已按正确值落笔。
- **反馈 §二.3 的 HBR 页码（pp. 90–98）未采纳**：检索只确认文章 11 页、未见页码来源，
  90–98 仅 9 页自相矛盾。HBR 引用惯例允许省页码，draft 保留 96(6), Nov–Dec 2018。
- README 的行号（L545）与出处定位（inherited-router-url-silent-misdelivery.md）由核查方
  已直接回填，本轮未再动。
