# 预印本 / 发布渠道对比（为 container-model 论文选路）

> 2026-08-24 整理。**依据分两档**：标了链接的 = 本轮检索核实过；标〔背景〕的 =
> 通识性结论，本轮未逐条核实，投稿前用到哪条再现查哪条。
> 结论先行：**首选 TechRxiv 占位 + 投 CHASE/CAIN 类会议；arXiv 等录用后再挂。**

---

## 一、逐渠道

### arXiv（首选目标，但当前进不去）

- **运营**：康奈尔大学图书馆，非营利。CS 领域事实上的标准渠道，可见度最高。
- **门槛 1 — 背书**：cs.SE 首投需在册作者背书；[2026-01-21 起机构邮箱不再自动豁免](https://blog.arxiv.org/2026/01/21/attention-authors-updated-endorsement-policy/)，所有新投稿人都要真找到背书人（对方近五年在该 domain 有足够论文、账号满 3 个月）。无挂靠 + gmail + 无发表史 = 这关很难。
- **门槛 2 — 内容形态**：[2025-10-31 起 CS 类不收未经同行评审的综述 / position paper](https://blog.arxiv.org/2025/10/31/attention-authors-updated-practice-for-review-articles-and-position-papers-in-arxiv-cs-category/)，须附录用/评审证明。我们的稿子写成了**带实证数据的经验报告**，理论上不属被禁形态——但 moderation 对无挂靠作者的边界稿从严，被划成 position paper 的风险真实存在。
- **费用 / DOI**：免费；有 DOI。
- **结论**：**会议录用后再来**——届时 position 限制解除（有评审证明），背书人也好找（评审圈内就有）。现在硬闯的期望收益低。

### TechRxiv（当前最优的占位渠道）✅

- **运营**：IEEE。定位就是电子工程 + CS 的预印本服务器，学科完全对口。
- **审核**：[有 moderation 但不是同行评审](https://www.techrxiv.org/faqs)——只查真实性、学科范围、抄袭、冒犯内容，不评估技术正确性/新颖性。经验报告形态没有 arXiv 那样的 position 禁令。审核时长官方未给数字（〔背景〕社区经验一般 1–3 个工作日）。
- **门槛**：注册即投，无背书制。不要求 IEEE 会员。
- **费用 / DOI**：[作者读者双免费，发布即发 DOI](https://www.techrxiv.org/about)。
- **可见性**：〔背景〕Google Scholar 正常收录 TechRxiv 的文章页；IEEE 背书对工程/CS 读者的信誉度好。
- **坑**：〔背景〕上传后同版本不可删（预印本通例，只能传新版本 + 打撤稿声明）；**发出去就是公开发表**，如果目标会议是双盲，先核对该会 preprint 政策（见 §三）。
- **结论**：**首选**。学科对口、无背书墙、有正经 DOI 和检索。

### Zenodo（备胎：存档强，可见性弱）

- **运营**：CERN，OpenAIRE 背景，非营利。
- **门槛**：注册即传，**零审核**，任何文件类型都收。
- **费用 / DOI**：免费；发 DOI，且支持版本化 DOI（每版一个 + 总 DOI）。
- **致命弱点**：[官方 FAQ 承认 Google Scholar 对 Zenodo 收录受限](https://support.zenodo.org/help/en-gb/18-general/61-is-zenodo-indexed-by-google-scholar)（依赖 URL 模式判断资源类型，非 article 类型不进；实践中 article 也大量收不进），[第三方观察确认 Zenodo/Figshare 内容普遍不出现在 Google Scholar](https://www.h63d-homozygous.com/blog/googlescholar)，Web of Science / Scopus 也不索引。**= 挂上去别人搜不到，只有拿着链接才找得到。**
- **强项**：长期存档（CERN 承诺）、版本化、和 GitHub 集成好（可以给 solo 仓库本身的 release 发 DOI——这个用途倒是很配：**论文引用软件本体时，给 SOLO 仓库挂个 Zenodo DOI**）。
- **结论**：不当论文主渠道；**当软件存档渠道**（给 SOLO 代码发 DOI 供论文引用）。

### SSRN（学科不对口，不推荐）

- **运营**：[Elsevier（2016 年收购）](https://en.wikipedia.org/wiki/Social_Science_Research_Network)，商业性质。
- **学科重心**：社科、法律、经济。[有 CompSciRN 子网](https://www.ssrn.com/index.cfm/en/compscirn/)但 CS 社区基本不看 SSRN。
- **审核**：[有 staff 筛查（范围/格式/基本学术性），非同行评审](https://casrai.org/guides/ssrn-how-it-works-for-researchers)；〔背景〕通常数个工作日。
- **费用**：阅读下载免费；〔背景〕投稿免费，但站内有付费推广位等商业化设计，下载页体验有登录墙倾向。
- **结论**：**不选**。除非论文改投组织行为学/管理学方向（human-AI teaming 的 OB 线在社科圈有受众）才有意义。

### OSF Preprints（可用备选）〔背景，未逐条核实〕

- 运营：Center for Open Science，非营利。注册即投、免费、发 DOI、审核宽松（只查范围与格式）。Google Scholar 收录正常。学科无壁垒，但 CS 圈存在感一般。→ TechRxiv 不顺时的第二选择。

### Preprints.org〔背景，未逐条核实〕

- 运营：MDPI。免费、有筛查、发 DOI、速度快（宣称 24h）。因 MDPI 品牌在学术圈的争议，信誉观感弱于 TechRxiv/arXiv。→ 不优先。

### HAL〔背景，未逐条核实〕

- 法国国家学术档案库。对非法国机构作者开放但流程偏机构向，首投有人工核验。除非有法方合作者，否则没有理由选它。

### viXra ⛔

- 无任何审核的 arXiv 镜像名。**学术信誉为负资产**——挂上去对论文是减分。绝对不用。

### ResearchGate / Academia.edu〔背景〕

- 社交网络，不是预印本服务器。可以在论文有正式落点后**转发**引流，但不当首发渠道（版权条款糙、DOI 非标准、学术引用不认）。

### 自托管 + Software Heritage〔背景〕

- 论文 PDF 挂自己域名 + 仓库进 Software Heritage 存档。完全可控但零可见性、零 DOI，只作为补充。

---

## 二、对比表

| 渠道 | 门槛 | 审核 | DOI | Google Scholar | 学科对口 | 结论 |
|---|---|---|---|---|---|---|
| arXiv | 🔴 背书 + position 禁令 | moderation | ✅ | ✅ 最强 | ✅ | 录用后再挂 |
| **TechRxiv** | ✅ 注册即投 | 轻审核 1–3 天 | ✅ | ✅〔背景〕 | ✅ IEEE/CS | **首选占位** |
| Zenodo | ✅ 零审核 | 无 | ✅ 版本化 | 🔴 基本不收 | 通用 | 只用于软件 DOI |
| SSRN | ✅ | 轻审核 | ✅〔背景〕 | ✅ | 🔴 社科向 | 不选 |
| OSF | ✅ | 轻审核 | ✅ | ✅ | 通用 | 第二备选 |
| Preprints.org | ✅ | 轻审核 | ✅ | ✅ | 通用 | 观感扣分，不优先 |
| viXra | ✅ | 无 | — | — | — | ⛔ 负资产 |

## 三、和会议投稿的相互作用（先看这个再动手）

1. **顺序**：预印本占位 ≠ 抢发优先权那么简单——**它和双盲评审冲突与否由各会 CFP 决定**。SE 圈主流（ICSE/FSE/ASE 系）近年是「允许已挂 preprint，但投稿期间别主动宣传」；CHASE/CAIN/FORGE 各自政策**投稿前必须现查当年 CFP**，别引用本文档的这句话代替现查。
2. **同一稿不能改头换面重挂**：预印本挂哪、挂几版都要在投稿系统里如实申报（多数系统有 preprint 声明栏）。
3. **录用后动作**：① 挂 arXiv（此时背书好解决、position 限制解除）；② camera-ready 的版权协议要核对允许保留 preprint（IEEE/ACM 都允许作者版 self-archiving，〔背景〕具体以签的协议为准）。
4. **软件本体**：给 solo 仓库通过 Zenodo-GitHub 集成发一个版本化 DOI，论文引用软件时用它——这也是 artifact evaluation（很多会有 artifact track）的加分项。

## 四、推荐路径（一句话版）

**TechRxiv 挂 v1 占位（免费、对口、有 DOI）→ 查目标会 CFP 确认 preprint 政策 → 投 CHASE 或 CAIN 经验报告档 → 录用后挂 arXiv + Zenodo 给代码发 DOI。**

---

来源汇总：[arXiv 背书新政](https://blog.arxiv.org/2026/01/21/attention-authors-updated-endorsement-policy/) · [arXiv CS position/综述新规](https://blog.arxiv.org/2025/10/31/attention-authors-updated-practice-for-review-articles-and-position-papers-in-arxiv-cs-category/) · [TechRxiv FAQ](https://www.techrxiv.org/faqs) · [TechRxiv About](https://www.techrxiv.org/about) · [Zenodo 官方 FAQ：Google Scholar 收录](https://support.zenodo.org/help/en-gb/18-general/61-is-zenodo-indexed-by-google-scholar) · [Zenodo/Figshare 不进 Scholar 的第三方观察](https://www.h63d-homozygous.com/blog/googlescholar) · [SSRN 维基（Elsevier 收购）](https://en.wikipedia.org/wiki/Social_Science_Research_Network) · [SSRN CompSciRN](https://www.ssrn.com/index.cfm/en/compscirn/) · [SSRN 运作说明 (CASRAI)](https://casrai.org/guides/ssrn-how-it-works-for-researchers)
