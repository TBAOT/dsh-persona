# 方案 A：常驻层改「索引句」，正文进主题库

状态：**slot-1 已执行**（2026-11-15），slot-2/3 待 dry-run。基线版本 0.10.6。

## 执行结果（slot-1，人工迁移）

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 常驻条目 | 16 条 / **2986 字（100%）** | **20 条 / 1430 字（48%）** |
| 条目形态 | 平均 187 字，最长 450 字 | 每条一句话，最长 118 字 |
| 正文去向 | — | 按主题归档（11 段进 `记忆系统细节`→ 再移入 `resident-archive`，其余进 `release-and-install` / `memory-eval` / `forgetting-ttl-research` / `磁盘与清理` / `legacy-session-corpus` / `memory-write-reject-policy`） |
| 备份 | — | `~/.dsh/trash/2026-11-15-slot-1-memory-2986chars.md` |
| `pnpm audit --persona=slot-1` | — | **0 个结构性错误**（3 条提醒：缺别名/超长） |
| `pnpm probe --split=tune` | 89%（8/9） | **89%（8/9）** 不变 |
| `pnpm probe --split=verify` | 100%（5/5） | **80%（4/5）**：`DSH 更新后插件失效` 一题被 `release-and-install` 抢到 |

**关于 verify 掉的那一题**（诚实记录，不粉饰）：`DSH 更新后我的插件就会失效，是权限问题还是版本问题？` 这句话里没有稀有词——`DSH`、`插件`、`更新`、`版本`、`权限` 在库里都出现在多篇主题，IDF 把它们的权重压得很低，于是"哪篇都沾一点"。加别名（`插件失效`/`更新`/`版本`）后 `release-and-install` 仍以 0.083 赢过 `权限修复` 0.061。硬把这题掰回来只能靠给常见词加权重，那会整体回退，所以**接受这个 miss 并记录**；留出集只有 5 题，单题翻转即 20%。

**迁移中踩到的两个坑（已修）**：写入归档时把 `summary` 一起覆盖了，导致 `release-and-install` / `memory-write-reject-policy` / `记忆系统细节` 的索引行变成无关句子（检索立刻乱）；另外 11 段正文一开始全塞进 `记忆系统细节`，把它撑到 3473 字并触发 `audit` 的近似重复告警——已抽出 `resident-archive` 承接，`记忆系统细节` 回到 1446 字。

## 0. 调研结论（三个待拍板问题已按 GitHub 实据改判）

> **2026-11-15 更正**：本节最初引用的 Letta 代码来自 `archive` 分支（V1，已退役）；当前实现已迁到 [`letta-ai/letta-code`](https://github.com/letta-ai/letta-code)（3.8k star，每日在推）。现在的 Letta 不再有 `memory_rethink`/sleep-time 工具集，而是 **MemFS**：git 版本化的 Markdown 记忆 + `MEMORY.md` 逐级索引 + `.memfs.config.json` 限额 + 提交前校验。`memory_rethink` 那套说法只能当历史看。
>
> 当前 Letta 的默认限额（[memory-constraints.ts](https://github.com/letta-ai/letta-code/blob/main/src/memory-constraints.ts)）：`maxFileCharacters: 20000`、`maxCoreMemoryCharacters: 65536`（根目录所有 Markdown 的合计，即"进系统提示的部分"）、`maxDepth: 2`；另有 `fileCharacterLimits`（按 glob 覆盖）、`readOnlyFiles`（受保护文件不可改）、以及"改限额需人工批准"（`LETTA_MEMORY_CONSTRAINTS_UPDATE` 环境变量才允许改配置）。
>
> 对我们的意义：**「根目录放索引、正文放子目录」正是 Letta v2 的 root-marker 布局**，方案 A 的方向被验证；值得补借的是 `readOnlyFiles`（把核心文件对 agent 设只读）与"提高上限需人工批准"这条纪律，而不是 rethink 工具。

| 问题 | 实据 | 改判 |
|---|---|---|
| 条目该多长 | 没有项目按"每条 60–80 字"限制：Letta 的块上限是 `CORE_MEMORY_PERSONA_CHAR_LIMIT = 20000`、`CORE_MEMORY_HUMAN_CHAR_LIMIT = 20000`、`CORE_MEMORY_BLOCK_CHAR_LIMIT = 100000` 字符（[constants.py](https://github.com/letta-ai/letta/blob/archive/letta/constants.py)）；mem0 的提取提示要求每条是 **15–80 词的自包含陈述**（[prompts.py](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)）；generative agents 每个记忆节点是**一句话**的 observation/thought，另带 poignancy/keywords/embedding（[associative_memory.py](https://github.com/joonspk-research/generative-agents/blob/main/reverie/backend_server/persona/memory_structures/associative_memory.py)） | **不用 60 字**。取「一条一个事实、≤120 字、一句话」：3000 ÷ 120 ≈ 25 条，条件分支写得下 |
| `rethink` 自动还是人工 | Letta 分了两套工具集：交互用的 `BASE_MEMORY_TOOLS_V2 = [memory_replace, memory_insert]`；`memory_rethink`、`memory_finish_edits` 只在 `BASE_SLEEPTIME_TOOLS` 里，源码注释："leaving these ones out to simply the set? Can have these reserved for sleep-time"（[constants.py](https://github.com/letta-ai/letta/blob/archive/letta/constants.py)、[base.py](https://github.com/letta-ai/letta/blob/archive/letta/functions/function_sets/base.py)） | **自动，但不进对话轮**：普通轮只许精确编辑（`add`/`patch`/`remove`）；整层重写放在**复盘之后的后台一轮**（Letta 的 sleep-time 对应物），校验不过整批放弃，绝不打断对话 |
| 迁移范围 | — | **三个角色都迁**（slot-1 98%、slot-2 99%、slot-3 91%），每个角色单独 dry-run、单独备份 |

同源补充：Letta 的压力不靠"拒绝"表达，而是上下文到 0.9 触发摘要（`SUMMARIZATION_TRIGGER_MULTIPLIER = 0.9`），并把"该存记忆了"作为系统提示插入对话（`MESSAGE_SUMMARY_WARNING_STR`）。我们的 0.9 转存阈值方向一致。

## 1. 现状（实测）

| 项 | 值 |
|---|---|
| `memory` 常驻 | 16 条 / **2952 / 3000 字符（98%）**，平均 185 字，最长 450 字 |
| `user` 常驻 | 9 条 / 709 / 1375（53%），平均 79 字 |
| 主题库 | 18 篇，平均约 1.3 KB |
| 写入行为 | 常驻 ≥90% 时 `add` 不拒绝、转存主题；**变长的 `patch` 仍被 100% 硬检查拒绝** |

问题不是预算太小，而是**常驻层里混着正文**：一条 185 字把"结论"和"过程"一起塞进索引位。压到 80% 只是 16 条变 13 条，几轮又满。

## 2. 设计：三层各司其职

| 层 | 放什么 | 形态 | 进提示词 |
|---|---|---|---|
| 常驻 `memory.md` | 结论、约定、判据、"下次该怎么办" | **一条一个事实、≤120 字、一句话** | 全量注入（冻结） |
| `topics/*.md` | 过程、命令、对照数据、背景 | 正文，按 slug 检索 | 只一行索引（slug｜摘要） |
| 召回块 | 本轮相关主题指针 | 前 3 篇摘要 ≤400 字符 | 每轮注入 |

不给每条加 `→ topics/xxx` 指针：每条多 20 字等于又把索引撑肥，指针由主题索引与召回提供。

## 3. 容量换算

- `memory` 3000 ÷ 120 ≈ **25 条**（现 16 条）；`user` 1375 ÷ 120 ≈ **11 条**（现 9 条，平均已 79 字）；
- 迁移后预估：`memory` 16 条 × ~110 字 ≈ 1700 字（**57%**），比现在 98% 回到"再装 10 条"的空间；
- 若某条实在压不下 120 字，正文进主题、常驻只留"判据 + 去哪看"。

## 4. 写入路径改造

1. **普通轮只给精确编辑**：`add` / `patch` / `remove`（现状），新增 **≤120 字**单条上限；超长时回执明说"请压成一句话，过程写 topic"，不静默截断。
2. **新增 `rethink`：只在后台轮里可用**（对应 Letta sleep-time）：
   - 触发：复盘写完之后，若该档 ≥90%，起一轮"整理"调用，工具集只有 `rethink`；
   - 形状：`{ action: 'rethink', content: '<整层新文本，一条一行>' }`；
   - 校验：非空、每行 ≤120 字、无完全重复、总字符 ≤ 上限、**行数不得少于原来的 2/3**（防大扫除丢事实）、不许出现 `old_text` 之外的新事实类别（无法机检，靠备份兜）；
   - 失败即整批放弃，回执写原因，不打断对话；成功则整层替换并 `refreshMeta` + 备份。
3. **满层行为**：保留 ≥90% 的"转存主题"兜底，但回执追加 `needsRethink: true` 与"建议合并的相近条目"，让后台整理轮有的放矢。
4. **复盘提示词**：条目写成结论句；过程/命令/数据一律 topic；`patch` 只给替换片段（已有规则）。

## 5. 数据迁移（一次性，幂等，三角色）

新脚本 `scripts/split-resident.mjs`（由 `split-memory.mjs` 的"路由 + 备份 + 可重复执行"骨架演进）：

1. `--dry-run`：逐条打印「原文 → 压成的一句话（≤120 字）→ 正文去哪个主题（复用 overlap≥0.6）」，等人过目；
2. `--apply`：先备份 `~/.dsh/trash/<日期>-<persona>-<target>-<字符数>chars.md`，再写索引句 + 追加主题正文；重复执行不会二次切割（已 ≤120 字的条目原样跳过）；
3. 收尾：`refreshMeta` + `writeTopicManifest` + `pnpm audit` 必须 0 错。

## 6. 验收标准

| 判据 | 目标 |
|---|---|
| 三个角色的常驻占用 | 都 ≤70%（slot-1 98% → ~57%，slot-2 99%、slot-3 91% 同法） |
| 条目数 | 每档不减（不得因压缩丢事实） |
| `pnpm probe --split=tune/verify` | tune ≥89%、verify 100%（不得回退） |
| `pnpm audit` | 三角色 0 个结构性错误 |
| `pnpm verify` | 全绿（新增 `rethink` 校验、120 字上限、后台轮不越权的用例） |

## 7. 实施顺序与回滚

1. **commit 1**：`rethink` 操作 + 120 字上限 + 校验 + 测试（不动数据、不接后台轮）；
2. **commit 2**：后台整理轮接线（复盘后判定 ≥90% → 起一轮）+ 测试；
3. **commit 3**：迁移脚本 `--dry-run` 输出贴给你看；
4. **commit 4**：`--apply` 三角色迁移 + probe/audit 数字 + CHANGELOG（0.11.0）。

回滚：原文在 `~/.dsh/trash`；代码走 `git revert`；数据不自动回写。

## 8. 已知取舍

- **120 字仍会丢条件分支**：靠"判据 + 去哪看"的写法补偿，`audit` 增加一条——条目里写"详见/见 topic"却指不到真实 slug 时报错。
- **`rethink` 有误删风险**：靠"行数不得少于 2/3 + 备份 + 整批放弃"兜，不寄望模型自律。
- **召回仍是关键词**：本方案不动检索，probe 的 14 题结论继续有效；语义检索是另一个议题。
