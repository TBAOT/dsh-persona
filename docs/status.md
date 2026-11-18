# 状态与验收（2026-11-15）

一页纸回答三件事：现在什么版本、哪些东西被证明过、还剩什么没验。

## 版本与提交

| 项 | 值 |
|---|---|
| 本地 main | `0.10.3`，tag `v0.8.4` … `v0.10.3` |
| 远端 | 已推送：`main` 从 `b787614` 追到 `d8d38de`，所有新 tag 都在远端 |
| CI | run #34（0.10.1）在 windows+node20 红过：集成测试清理临时目录 `ENOTEMPTY`（后台复盘还握着文件句柄），已用 `rm({maxRetries})` + 轮询 `waitForFile` 修掉，见 0.10.3 |
| 安装方式 | 本机 profile bundle 是 `link:C:\A\work\优质项目\dsh-persona-kit`，改代码后要重载/重启才生效 |
| 测试 | 117 项（`pnpm verify`：`node --test` + 补丁结构检查） |

## 这一轮改了什么（0.8.4 → 0.9.7）

- **0.8.4 修复批**：召回注入按 Host 契约重写（此前一行字面量 `\n` 把代码注释掉，错误被空 `catch` 吞掉，九版没生效）；`TokenUsage` 按 camelCase 读（旧读法让指标恒为 0）；`finish.reason` 按对象判定截断；转存带摘要；`patch` 复述上下文被拒；相似覆盖可见。
- **0.9.0–0.9.2**：主题 `keywords` 别名；IDF 加权；评测换成 14 道真实题 + 三数同报 + holdout；面板 API 加 loopback 门禁；复盘提示词禁止「复述 old_text 的 patch」与「无检索价值的摘要」。
- **0.9.3**：`pnpm health`，用一条命令回答召回在不在跑。
- **0.9.4**：溢出转存复用相近主题（此前一次写满生三个近重复主题）。
- **0.9.5**：同一事实写进两个档时当场提示。
- **0.9.6**：端到端回归——同一轮里注入与指标必须对得上（reject 不得记成注入）。
- **0.9.7**：评测泄漏守卫——题库问题被抄进主题库时测试失败。
- **0.10.0**：面板页脚显示本轮召回（`召回 3 篇 / 171 字符`，悬停看 outcome/slug/耗时），来自新增的 `GET /health`；异常态复用既有 warn 色，不加徽章与动画。

## 被证明过的事实

| 结论 | 证据 |
|---|---|
| 召回在 0.8.4 之后真的注入 | 同一 payload 在 0.8.3 上 false/false/0，在 0.8.4 上 true/true/60（`%TEMP%\persona-old-recall-evidence.mjs`） |
| 线上 token 计量是真的 | `metrics.jsonl` 出现 `tokens {in:2602,out:441,cacheRead:512}`、`usageMissing:false` |
| 真实题检索水平 | tune 89%（8/9）、verify 100%（5/5）、注入约 175 字符、4ms 级 |
| 三种归一化不改变排名 | 覆盖率 / sqrt / 饱和的 miss 完全一致——「长查询稀释」不成立 |
| 摘要改写会过拟合 | tune 44%→56%、verify 100%→80%，已回滚 |
| 评测语料会自我污染 | 把题目原文写进主题后 verify 100%→80%，删掉后恢复 |

## 还没验的

- **0.9.x 未进内存**：应用最后启动于 09:49，`metrics` 里的 `recall.outcome` 仍是 0.8.4 形状的 `unknown`。重载/重启后跑 `pnpm health`，`unverified` 应变成 `ok`。
- **远端未推送**：本地 10 个提交在等网络。

## 怎么自己验一次

```powershell
cd C:\A\work\优质项目\dsh-persona-kit
pnpm verify                                  # 108 项测试 + 补丁结构
node scripts/probe.mjs --persona=slot-1 --split=verify   # 留出集：应 100%
node scripts/health.mjs                      # 运行时体检：ok / broken / silent / unverified
```

`health` 的 `unverified` 专门用来区分「看不出」与「坏了」——把前者当后者会重演一次误判。
