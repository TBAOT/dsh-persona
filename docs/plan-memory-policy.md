# 方案：记忆策略（只读档 / 限额审批 / 分文件上限）

状态：**待批准**。日期 2026-11-15，基线 0.11.0-4。

## 0. 为什么做这个

前一轮查证（[letta-code 的 MemFS](https://github.com/letta-ai/letta-code/blob/main/src/memory-constraints.ts)）暴露了我们缺的不是"更聪明的检索"，而是**护栏**：

- Letta 的 `readOnlyFiles` 可以让某些记忆对 agent 只读，只有人能改；
- Letta 改限额要 `LETTA_MEMORY_CONSTRAINTS_UPDATE`，**不能由 agent 或随手改配置提高**；
- Letta 的限额是分层的：`maxFileCharacters`（单文件）+ `fileCharacterLimits`（按 glob 覆盖）+ `maxCoreMemoryCharacters`（进提示词的总量）+ `maxDepth`。

我们现在只有一个全局常量组合：`ENTRY_MAX_CHARS=120`、`TOPIC_MAX_CHARS=4000`、每个角色的 `{user, memory}` 两档上限。缺"谁可以改哪些文件"这一层。

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

## 4. 限额审批

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
