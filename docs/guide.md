# dsh-persona 原理与使用手册

一页讲清：它怎么记住东西、提示词里出现什么、写进去会发生什么、满了怎么办、出问题看哪里。

## 1. 它是什么

给 DSH 加一层「按角色独立的长期记忆」：每个角色自己有用户画像、自己的笔记、自己的主题库。
存储是本地 Markdown，不联网、不上传；提示词里只放该放的那一小部分。

四个插件行（同一 bundle，一起加载）：

| 行 | 职责 |
|---|---|
| `persona-memory` | 拼提示词（画像/常驻/主题索引）、提供 `memory` 工具、每轮召回 |
| `persona-review` | 每轮结束复盘（写记忆）、复盘后的后台整理轮 |
| `persona-roster` | 角色名册、工作区绑定、面板 HTTP API |
| `persona-skills` | 角色私有技能 |

## 2. 数据在哪

```
<DSH_HOME>/personas/
  index.json                角色名册：id、名字、容量上限、绑定的工作区（最长前缀匹配）
  slot-1/
    memory/user.md          用户画像（谁、偏好、忌讳）
    memory/memory.md        角色笔记（结论、约定、判据）
    memory/meta.json        每条的状态：active / superseded / removed、TTL、失效链
    memory/index/manifest.json   主题索引（派生文件，可重建）
    topics/<slug>.md        正文与细节：过程、命令、对照数据
    topics/archive/         已归档的主题（不删，只是不再注入）
    review/log.jsonl        每轮复盘审计（应用了哪些操作、被拒的原因）
    review/metrics.jsonl    每轮指标（召回、tokens、耗时、转存次数）
    review/evidence.jsonl   hash 级的写留痕
```

## 3. 读路径：提示词里到底出现了什么

一次会话的提示词由三段构成，**在首次拼提示词时读取并冻结**（`lib/memory.js` 的 `snapshotOf`）：

1. `## 用户画像 / USER PROFILE [xx% — n/n 字符]`（order 0.61）——`user.md` 全部条目；
2. `## 长期记忆 / MEMORY [...]`（order 0.62）——`memory.md` 全部条目；
3. `## 主题库 / TOPICS`（order 0.63）——每篇主题一行「slug｜摘要」，不是正文。

为什么冻结：提示词前缀稳定才能命中文档级缓存，而且同一会话里记忆不会"自己变"，避免前后矛盾。
代价：**本会话写入的内容，下一个会话才出现在提示词里**（工具回执始终显示实时用量）。

**每轮召回**（`agent/pre-step`，`lib/recall.js`）：

- 取这一轮最后一条 user 消息作查询；
- 对主题库打分：`slug + summary + keywords` 占 0.7、正文占 0.3，再乘 IDF（到处出现的词权重接近 0）；
- 取前 3 篇摘要，拼成 ≤400 字符的块，追加到 `decision.messages` 的最后一条 user 消息后；
- 一轮只注入一次（按 turn 去重）；空消息/斜杠命令/寒暄（嗯、好、继续…）跳过；
- 任何异常都只记录 `outcome` 不打断这一轮；`recallTopN: 0` 可整体关闭。

## 4. 写路径：谁在写、什么时候写

### 4.1 对话里显式写（`memory` 工具）

```
target: user | memory | topic
operations: [{ action: add | patch | remove, content, old_text }]
```

- `add`：**一条一个事实、≤120 字**。超长直接拒，并告诉你压成一句话、过程写 topic；
- `patch`：只给"替换 old_text 的那一小段"，复述上下文会被拒（否则会把句子写两遍）；patch 不设长度上限，它正是把旧长条目改短的路径；
- `remove`：按唯一片段删整条；
- `target=topic`：写正文，需要 `topic`（slug）+ `summary`（≤30 字）+ 可选 `keywords`（检索别名）。

写时会做三件事：与同档条目比对（相似度 ≥0.8 视为改写，替换旧条并在回执里显示"已合并覆盖旧条目"）、与另一档比对（跨档近重复给提示）、写完后对齐 `meta.json`。

### 4.2 每轮自动复盘（`persona-review`）

- 触发：`agent/turn-stopping`，同一 session+turn 只跑一次；
- 输入：最近 12 条消息（内存缓冲，镜像到 `storages/persona-buffers/`，重载后可恢复）+ 当前两档记忆 + 容量占用；
- 输出：一批 `ops`，逐条走和工具相同的写入校验；
- 门控：最后一句是寒暄/斜杠命令 → 不调模型；输出按"严格 JSON → 修复 → 逐对象抢救"三层解析；被截断会翻倍预算重试一次；
- 四态落 `log.jsonl`：已写入 / 无改动 / 跳过 / 失败（含被拒原因）。

### 4.3 后台整理轮（整层重写，`rethink`）

- 时机：复盘之后，**同一角色的常驻 ≥90%** 且距离上次整理 ≥30 分钟；
- 动作：把整层交给模型重写成更少、更干净的条目，然后校验：每行 ≤120 字、无重复、总字符 ≤ 上限、**条数不得少于原来的 2/3**；
- 通过才写：先备份到 `~/.dsh/trash/`，再替换，并写一条 `kind: "consolidate"` 的 metrics；
- 不通过或模型输出不合法：整批放弃，只记账，不动文件。

**为什么整理不给你在对话里调用**：照 Letta 的做法（`memory_rethink` 只给 sleep-time agent），对话轮只做精确编辑，整层重写放在后台——避免它在聊天中途大扫除。

## 4.4 谁可以改哪些记忆（`memory/policy.json`）

规则文件**归人所有**：插件永不写它，面板是唯一写入方（照 Letta 的 `.memfs.config.json` + "改它要人工批准"）。

```json
{ "version": 1, "readOnly": ["user"], "entryMaxChars": 120, "topicMaxChars": 4000,
  "limits": { "user": 1375, "memory": 3000 } }
```

| 字段 | 作用 | 默认 |
|---|---|---|
| `readOnly` | agent 不可写的档：`user` / `memory` / `topic`（面板仍可写） | `[]`（全开） |
| `entryMaxChars` | 单条常驻上限 | 120 |
| `topicMaxChars` | 单篇主题上限 | 4000 |
| `limits` | 覆盖 `index.json` 的容量；冲突时**以 policy 为准** | 无 |

生效点：`memory` 工具、复盘、后台整理轮、`writeTopic` 全部先过 `assertWritable`；只读被拦时工具回执写明"只有人能在面板解锁"，复盘记 `rejected: read-only`。文件坏了不会阻断记忆——回落默认值并给一条警告。

## 5. 容量：撞上限会发生什么

| 情形 | 行为 |
|---|---|
| 常驻 ≥90%，`add` 新条目 | **不拒绝**，转存为 topic（内容不丢，只是不进常驻层），回执会说明 |
| 批量写完后常驻 >100% | 整批拒绝，并告诉你差多少字符（通常是 `patch` 把条目改长了） |
| 单条 `add` >120 字 | 拒绝，要求压成一句话 |
| 主题正文 >4000 字 | 拒绝，要求拆分 |
| 完全重复的 `add` | 拒绝（"已有完全相同的条目"） |

`addOverflow: 'reject'` 可恢复"超限即拒"；`routeThreshold: 0` 关掉转存（只剩 100% 硬检查）。

**遗忘不是删除**：`patch` 会让旧条目转 `superseded` 并留下"被谁顶替"的 hash；过期条目（`ttlDays`，默认 memory 180 天）只在读侧过滤，文件里仍在；`GET /memory/history` 可查。

## 6. 角色与工作区

- `index.json` 里每个角色有 `workspaces` 列表；会话按工作目录**最长前缀匹配**决定用哪套记忆；
- 没被任何角色认领的目录 → 落到 `default`（空池）；
- 绑定即时生效，但**已开启的会话用启动时的快照**，所以要换角色得开新会话；
- 面板「角色」视图可改容量、绑/解绑工作区、看复盘记录与已失效条目。

## 7. 观测：怎么知道它真的在工作

| 入口 | 看什么 |
|---|---|
| `pnpm health` | 每个角色最近 5 轮的注入次数、outcome 分布、tokens；verdict：`ok`/`broken`/`silent`/`unverified`/`stale` |
| `pnpm audit` | 记忆库结构：空摘要、超限、近似重复主题、档内/跨档重复、meta 漂移（这些算错误），缺别名/超长/接近上限只提醒 |
| `pnpm probe` | 检索质量：14 道真实题，按题型报命中率 / 平均注入字符 / 平均耗时；`--split=tune|verify` |
| `GET /health?id=` | 面板页脚那一格的数据源（含 `readout.label/title/tone`） |
| 面板页脚 | `召回 3 篇 / 171 字符`，悬停看 outcome、耗时、注入了哪几篇 |
| `review/metrics.jsonl` | 每轮一行：`recall{outcome,chars,topics,ms}`、`tokens{in,out,cacheRead}`、`usageMissing`、`blocked`、`redirected` |

## 8. 日常怎么用（操作手册）

- **想让它记住**：正常说话就行，复盘会写；不需要说"记住这个"。
- **想让它忘/改**：直接说"把那条删掉/改成…"；或去面板编辑。
- **想让它整理自己**：到**该角色绑定的工作区**开会话，发一句普通的话；常驻 ≥90% 时整理轮会在这一轮结束后自动跑（寒暄单词会跳过复盘，但整理轮本身不受影响）。
- **想换角色/换容量**：面板「角色」页。
- **升级后确认生效**：重载或重启 → `pnpm health`（`unverified` 应变 `ok`）→ 发一句话看 metrics 的 `recall.outcome` 与 `tokens` → 面板页脚出现「召回 N 篇」。面板没变先 `Ctrl+R`。
- **回滚**：数据原文都在 `~/.dsh/trash/`；代码用 `git revert`。

## 9. 配置项（都挂在插件行的 `config` 下）

| 键 | 默认 | 作用 |
|---|---|---|
| `personaId` | `default` | 没绑定工作区时的兜底角色 |
| `userLimit` / `memoryLimit` | 1375 / 2200 | 两档字符上限（每个角色也可在面板单独设） |
| `inject` | `true` | 关掉则只保留工具，不注入提示词 |
| `topics` | `true` | 关掉主题库 |
| `topicsIndexLimit` | 600 | 主题索引的字符预算 |
| `topicTtlDays` | 90 | 主题多久不更新就不再注入（0 = 永不过期） |
| `recallTopN` / `recallBudget` | 3 / 400 | 每轮召回几篇、块多大 |
| `routeThreshold` | 0.9 | 到这个占用比就把 `add` 转存主题 |
| `addOverflow` | `topic` | 改成 `reject` 则恢复"超限即拒" |
| `consolidate` / `consolidateThreshold` / `consolidateCooldownMs` | `true` / 0.9 / 30 分钟 | 后台整理轮的开关、触发线、冷却 |
| `ttlDays` | `{memory:180}` | 条目有效期（日期粒度，读侧过滤） |
| `enabled` / `dryRun` / `everyTurns` / `maxTokens` / `provider` / `model` | 复盘相关 | 关闭复盘、只记不写、每几轮一次、输出预算、指定模型 |

## 9.5 升级 DSH 之后怎么确认没坏

插件声明了 `engines.dsh`（当前 `>=0.2.2-rc.1 <0.3.0`），安装/启用时加载器会按它拦版本；但**版本号拦不住"字段改名"**——我们踩过两次（`TokenUsage` 变 camelCase、`finish.reason` 变对象），都是版本号合法、行为静默失效。

所以插件启动时会**探测宿主接缝**，结果写到 `~/.dsh/storages/persona-compat.json`，并出现在两处：

```powershell
pnpm health   # 末尾一行：宿主兼容：插件 0.11.11 · 必需接口齐全 · 召回走 runtime-context
curl -H "x-dsh-persona: 1" "http://127.0.0.1:<port>/dsh-persona/api/health?id=slot-1"   # 字段 compat
```

| 探测项 | 必需 | 缺了会怎样 |
|---|---|---|
| `events`（`ctx.on`） | 是 | 插件无法工作，`health` 退出码 1 |
| `tools`（`ctx.tools.register`） | 是 | 同上 |
| `promptSections`（`ctx.systemPrompt.section`） | 是 | 同上 |
| `runtimeContext`（`ctx.systemPrompt.context`） | 否 | **降级**：召回块回落到追加用户消息（会出现在你的消息里），并记 `degraded` |

**降级不等于坏**：`health` 里看到 `降级 xxx` 说明那条路走了旧的兜底；看到 `缺必需接口` 才是真不兼容。

**本机是 unmanaged 形态的插件**（不在 bundles 列表里），改完代码 `set_bundle` 只会回 `restart-required`，**必须重启 DSH** 才生效。

## 10. 已知限制（诚实版）

1. **检索是关键词**：CJK 2-gram + 摘要/别名 + IDF。问句里若没有稀有词（"DSH 更新后插件失效"），可能被"沾边"的主题抢走——留出集当前 80%，不是 100%。
2. **冻结快照**：本会话写的东西，本会话看不到。
3. **复盘每轮一次模型调用**：寒暄门控能挡一部分，但长对话成本仍在。
4. **主题只增不减**：TTL 只在读侧过滤，归档要手动（面板悬停「归档」）。
5. **面板 API 只做 loopback + 固定头**，不是身份认证；别把端口暴露出去。
6. **自动整理轮的效果尚未在真实会话里验证**（单测覆盖了校验与失败路径）。
