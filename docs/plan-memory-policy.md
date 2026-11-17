# 方案：记忆策略（只读档 / 限额审批 / 分文件上限）

状态：**待批准**。日期 2026-11-15，基线 0.11.0-4。

## 0. 先查别人怎么实现（这次不自己拍）

| 项目 | 有没有"只读 / 限额审批" | 具体做法（源码为据） |
|---|---|---|
| [`letta-ai/letta-code`](https://github.com/letta-ai/letta-code)（3.8k★，活跃） | **两个都有** | ① 只读靠**受保护的路径 glob**：`.memfs.config.json` 里的 `readOnlyFiles`，"matching paths cannot be created, changed or removed"，由 git **pre-commit 校验器**在提交时拦截；② 限额也在这个文件里（`maxFileCharacters` / `fileCharacterLimits` / `maxCoreMemoryCharacters` / `maxDepth`），而**改这个文件本身要人工批准**——校验器里写死 `if (configChanged && env[LETTA_MEMORY_CONSTRAINTS_UPDATE] !== '1') error("requires human approval to change")`；提示语还写着 *"Do not raise or disable these limits unless the user explicitly approves it."* |
| Letta V1（archive） | 有 | 每个 block 有 `read_only: bool` 字段；编辑只读块的错误文案是 `READ_ONLY_BLOCK_EDIT_ERROR = "Error This block is read-only and cannot be edited."` |
| `mem0ai/mem0`（69k★） | 没有 | 只有作用域隔离（`user_id` / `agent_id` / `run_id`）与归属标记（`attributed_to`）；没有"某些记忆不可被 agent 改"的概念 |
| `getzep/graphiti`（33k★） | 没有 | 只有时间失效；不区分"人写"与"agent 写" |
| `run-llama/llama_index`（53k★） | 没有 | 记忆是应用侧对象，agent 不直接写 |

**结论**：只读 + 限额审批**不是行业标配，只有 Letta 做了**；而它做的两件事特别值得抄：

1. **策略文件本身是"人工所有"的**：agent 能写记忆内容，但改不了规则文件；改规则需要一个只有人能设的开关（env var）。
2. **拦截点放在"提交"这一层**：不是在每个写入口散落判断，而是在唯一的落盘闸门统一校验，并且"只拦本次改动引入的问题，历史问题打 warning"。

我们照此翻译成没有 git 的版本：`policy.json` = 那个人工所有的规则文件；插件**永不写它**；面板是唯一写入方；所有写入口在落盘前查它；提高上限 = 面板里一次显式确认 + 审计行。

## 1. 目标与非目标

**目标**（按价值排序）

1. 能把某些档设成**只读**：agent 写不进去，人可以在面板解锁；一次误写不会毁掉画像。
2. **限额不可被静默提高**：提高每角色上限必须是一次显式的、留下审计记录的"人类动作"。
3. **分文件/分目录的字数上限**：常驻条目 120 字、主题 4000 字之外，允许按 persona 覆盖（例如某个角色的主题可放宽到 8000）。

**非目标**

- 不做 git 版本化（Letta 的做法；我们是本地小库，`trash` 备份够用）；
- 不改检索算法；
- 不在这轮做多角色批量迁移（另有计划）。

## 2. 数据形状：新增 `memory/policy.json`

放在每个角色目录下，**与记忆文件同源、可手改、缺省即默认值**（读到坏 JSON 时按默认处理并记一条警告，不阻断启动）：

```json
{
  "version": 1,
  "readOnly": ["user"],
  "entryMaxChars": 120,
  "topicMaxChars": 4000,
  "limits": { "user": 1375, "memory": 3000 }
}
```

- `readOnly`：哪些档不可被 agent 写（`user` / `memory` / `topic`），仍可被人写；
- `entryMaxChars` / `topicMaxChars`：覆盖常量默认值；
- `limits`：与 `personas/index.json` 重复时**以 policy 为准**（policy 是"记忆自己的规则"，index 是名册的便捷入口），并在面板显示实际生效值。

> 为什么不塞进 `index.json`：那个文件由名册服务整体读写，面板每次改名/绑定都会重写它；把"记忆规则"混进去，一次面板操作就可能覆盖掉手改的策略。分开则互不干扰。

## 3. 生效点（谁被拦、谁不受影响）

| 写入路径 | 只读档被拦 | 说明 |
|---|---|---|
| `memory` 工具（对话里） | ✅ 拒绝并给理由 | 回执：「user 档已设为只读，只有人能在面板解锁后修改」 |
| 复盘自动写（review） | ✅ 跳过该档，记 `rejected: read-only` | 复盘提示词里同时声明"这些档只读，不要输出针对它们的 ops" |
| 后台整理轮（consolidate） | ✅ 跳过该档 | 不重写只读档 |
| 面板编辑（人） | ❌ 不拦 | 这是"人解锁"的入口；保存时写审计 |
| `pnpm split-resident` 等脚本 | ❌ 不拦 | 运维脚本等同人工动作，但会打印"目标档只读"提示 |

字数上限的生效点：`store.applyOperation`（条目）、`topics.writeTopic`（主题）、`applyRethink`（整层）。取值顺序：policy → 常量默认。

**为什么集中在一个闸门**（照 Letta 把校验放在 pre-commit）：写入口会越加越多（工具、复盘、整理轮、脚本、面板），每个入口各写一遍"是否只读"迟早漏一处。所以新增一个 `assertWritable(persona, target)`，所有落盘前的路径都必须先过它；绕过它的写法在 review 里会被当成 bug。

## 4. 限额审批（照 Letta 的"规则文件归人"）

- **谁能改**：只有面板（人）或手改 `policy.json`；
- **改的时候留痕**：面板保存后追加一条 `review/log.jsonl`，`{actor: 'human', action: 'limits', from, to}`；
- **提高上限要确认**：面板里把上限调大时，按钮文字从「应用」变成「确认提高上限」，并在行内显示"当前 3000 → 新 5000"；
- **插件配置不再能覆盖**：`config.userLimit/memoryLimit` 只在**没有 policy 且角色无名册记录**时作为兜底，避免"改一行 YAML 就把闸门抬高"。

## 5. 测试清单（都进 `pnpm verify`）

| 用例 | 断言 |
|---|---|
| policy 缺失 | 默认值生效，行为与现在完全一致 |
| policy 坏 JSON | 按默认处理 + 一条警告，不崩 |
| `readOnly: ['user']` 时工具写 user | 拒绝，文案含"只读" |
| 同角色写 memory | 正常 |
| 复盘遇到只读档 | 记 `rejected: read-only`，memory 档照常写 |
| 整理轮遇只读档 | 跳过，其它档正常 |
| `entryMaxChars: 60` | 61 字的 add 被拒，60 字过 |
| `topicMaxChars: 500` | 501 字主题被拒 |
| policy 与 index 上限冲突 | policy 胜，且面板读到的生效值一致 |
| 提高上限 | 面板路径写入审计行；插件 config 路径不再生效 |

## 6. 验收标准

1. `pnpm verify` 全绿（新增 ≥10 项）；
2. `pnpm audit` 增加一条检查：**只读档被 agent 写入过**（依据 evidence/log 的 actor）→ 报错；
3. 实测：把 slot-1 的 `user` 设只读 → 让复盘尝试写 → `log.jsonl` 出现 `rejected: read-only`，`user.md` 未变；
4. 面板改上限 → `log.jsonl` 多一条 `actor: human` 记录。

## 7. 实施顺序（3 个提交）

1. **`lib/policy.js` + 生效点接线**：读 policy、默认值、工具/复盘/整理/写入上限全部走 policy；测试；
2. **面板**：只读开关、生效值展示、提高上限的二次确认 + 审计行（按 `/frontend-design` 两段式做，先出 token/layout 方案）；
3. **`pnpm audit` 增强 + 文档**：只读篡改检查、`docs/guide.md` 补"谁能改哪些记忆"一节。

回滚：policy 是新增文件，删掉即回到默认；代码 `git revert`。

## 8. 需要你拍板

1. **默认谁只读**？我建议 `user`（画像）默认只读——画像被"自动复盘"改错的代价最高；`memory` 保持可写。也可以两个都先可写、等你手动开。
2. **上限提高要不要二次确认弹窗**，还是面板内联的"确认"按钮就够？（我倾向前者用内联，不弹窗打断。）
3. **`config` 里的 `userLimit/memoryLimit` 要不要直接废弃**（只留 policy/面板）？废弃更干净，但会让老配置静默失效——需要一次迁移提示。
