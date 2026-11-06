# dsh-persona

[![verify](https://github.com/TBAOT/dsh-persona/actions/workflows/verify.yml/badge.svg)](https://github.com/TBAOT/dsh-persona/actions/workflows/verify.yml)

给 DeepSeek Harness 加"角色记忆"：每个角色两档长期记忆，会话开始时冻结注入，写满会拒绝并要求合并。

A persona-memory plugin for DeepSeek Harness. Two tiers (`user` profile and the
persona's own `memory` notes), frozen into the prompt at session start, with hard
character limits and explicit `add` / `patch` / `remove` operations.

## 安装

> 注意：npm 上的 `dsh-persona` 是**别人占的名字**（同名 `0.0.1`，描述写着 name reserved），
> 本仓库没有发布到 npm。请从 git 安装。

```sh
# 从仓库装（推荐）
dsh plugin --profile <profile> add github:TBAOT/dsh-persona

# 或者本地开发：clone 后把链接写进 profile
dsh plugin --profile <profile> add link:C:/path/to/dsh-persona
```

装完后把 `dsh-persona` 加进 profile 的 `dsh.profile.bundles` 列表，重启 Harness。

## 面板（左侧栏「角色」）

装好并启用后，左栏底部多一个「角色」图标，点开是整页面板：

- **左侧**：角色列表（名字、槽位 id、绑定工作区数量）
- **记忆**：两档编辑器（用户画像 / 角色笔记），带用量与上限，超限会被拒绝
- **复盘记录**：最近 30 条，含模型、写入/拒绝、跳过原因
- **工作区**：下拉就是应用里已有的工作区（标题、路径、会话数、已属于哪个角色），选中即绑定；也可以手动填一个子目录路径（该目录必须真实存在）。绑定后该目录及其子目录下的会话自动归这个角色。

角色是**槽位制**：包里声明 4 个槽位（`slot-1`…`slot-4`），面板里新建角色就是占用一个空槽，
名字可以随时改，记忆目录跟着槽位走（改名不丢记忆）。

角色归属由**会话的工作目录**决定，不需要在新建会话时选预设：
`工作区 → 角色`的映射存在 `<DSH_HOME>/personas/index.json`。

## 每轮复盘（自动写）

回合结束后跑一次模型，读对话摘要 + 当前记忆，返回结构化改动，写入同一套存储。特点：

- **不阻塞回复**：回合关闭后才发起。
- **不改本轮提示词**：冻结快照属于打开它的那个会话。
- **逐条可查**：每次写入记在 `<角色>/review/log.jsonl`，含轮次、模型、应用/拒绝原因。
- **单条超限只拒那条**，其余照写。
- 模型输出不是合法 JSON 时记 `parse-failed`，不重试、不乱写。

模型来源（按顺序）：插件配置的 `provider` + `model` → 平台默认模型 → 都没有就跳过并记一条警告。

```yaml
- id: persona-review
  name: dsh-persona/review
  config:
    personaId: default
    enabled: true
    everyTurns: 1        # 每 N 轮复盘一次
    maxTokens: 1200
    dryRun: false        # true = 只记录不写入，用来观察它想写什么
    provider: wb-proxy   # 可选；不填则用平台默认模型
    model: deepseek-v4.1-flash
```

## 没绑角色的工作区

会话的 cwd 不属于任何角色的工作区时，插件回退到配置里的 `personaId`（默认 `default`）：
记忆照写、复盘照跑，全部落在 `personas/default/`。这个桶不在名册里，所以它不隔离——
所有未绑定的项目共用一份。面板把它显示成「未认领池」：能看到里面的原文，也能一键并进
当前角色（`POST /dsh-persona/api/adopt`；与目标条目去重、超上限整批拒绝、成功后池子清空）。

想彻底避免：把工作区绑到角色，或在面板里给这些目录认领一个角色。

## 私有技能（某角色独有）

把技能放进该角色自己的目录：

```
<DSH_HOME>/personas/<角色>/skills/
  <技能名>/SKILL.md      目录式
  <技能名>.md            平铺式
```

`SKILL.md` 用 frontmatter 写 `name` 与 `description`（可选 `whenToUse`）。

生效方式：会话开始时，插件只把**本角色**目录下的技能做一个索引（名字 + 说明 + 文件路径）
注入该会话的提示词；其它角色完全看不到这份索引。需要用到时，模型按给出的路径读全文。

为什么不用平台技能目录：平台技能根是全局的，而补丁里写不了"每个用户各自的绝对路径"；
换成运行时按角色注入，既不用改配置，也保证了隔离。

共享技能照旧放 `~/.dsh/skills` 或 `~/.agents/skills`，所有角色都能用。

## 数据在哪

```
<DSH_HOME>/personas/<角色>/memory/
  user.md      用户画像（默认上限 1375 字符）
  memory.md    角色笔记（默认上限 2200 字符）
  topics/      预留：按需读取的细节
```

`DSH_HOME` 默认是 `~/.dsh`。文件是普通 Markdown，条目之间用单独一行 `§` 分隔，
第一行是版本注释，方便以后迁移。可以直接编辑、备份、进版本库。

## 为什么冻结

记忆在会话开始时读一次，之后整个会话不再变。原因有两个：

1. 系统提示词前缀稳定，供应商的前缀缓存才能命中（实测命中率九成以上）；
2. 会话中途改系统提示会打穿缓存，越聊越贵。

代价是：本会话写入的新记忆，下一个会话才出现在提示词里。工具返回始终显示实时用量。

## 工具

模型通过 `memory` 工具维护记忆：

| 操作 | 行为 |
|---|---|
| `add` | 追加一条；与已有条目完全重复会被拒绝 |
| `patch` | 用 `old_text` 定位唯一片段并替换 |
| `remove` | 用 `old_text` 定位并删除整条 |

- 必须指定 `target`：`user` 或 `memory`。
- 一次调用可带多条 `operations`，按顺序执行，**最终**结果必须在上限内。
- 超限时整批拒绝，并回显现有条目与还差多少字符——请先合并或删除，再添加。
- 写入前会检查不可见 Unicode 字符与疑似密钥/私钥，命中即拒绝。

## 从 soul-md 迁移

如果之前用过 `dsh-soul-md`，它的人设卡与记忆可以整包搬过来（源数据不动，可重复运行）：

```sh
node scripts/migrate-soul-md.mjs --persona slot-1 \
  --patch ~/.dsh/profiles/<profile>/cordis.patch.yml
```

规则：

- 每张卡片 → `personas/<角色>/skills/<卡片名>/SKILL.md`（按需读取，不占记忆预算）
- soul-md 的记忆文件 → 记忆条目；放不下的转成技能笔记文件，不会丢内容
- 重复运行会覆盖同名技能、跳过重复条目

## 配置

```yaml
- id: persona-memory
  name: dsh-persona
  config:
    personaId: default     # 角色 id，决定记忆目录
    userLimit: 1375        # 用户画像上限（字符）
    memoryLimit: 2200      # 角色笔记上限（字符）
    inject: true           # 关掉则只保留工具、不注入提示词
    userTitle: 用户画像 / USER PROFILE
    memoryTitle: 长期记忆 / MEMORY
```

一个角色 = 一个 `personaId` = 一份记忆。想让多个角色各自独立，为每个角色挂一行
`dsh-persona`，给不同的 `personaId`。构建者也可以把它挂进各自角色的预设里。

## 隐私

- 记忆是本地明文文件，不会上传到任何地方。
- 只有模型调用时，注入的那部分文本会随提示词发给**你自己配置的模型供应商**。
- 插件本身不联网。

## 卸载

从 bundles 列表移除并卸载包即可。`<DSH_HOME>/personas/` 下的数据不会删除，可自行备份或清理。

## 许可

MIT
