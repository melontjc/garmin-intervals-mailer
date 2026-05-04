# 身体状态分析师功能模块需求文档

## 需求概览

在现有 Cloudflare Worker 中新增 **Body Status Analysis** 功能模块，与现有 **Ride Analysis** 并列运行。骑行分析继续每 30 分钟检查新骑行并发送邮件；身体状态模块每天发送两封邮件：

- 晨间身体状态分析：北京时间 09:20，分析昨夜睡眠和今晨恢复状态。
- 晚间身体小报：北京时间 21:00，分析当天活动/运动负荷、压力和恢复趋势。

数据源只使用已经同步至 Intervals.icu 的 Garmin 与 Oura Ring 数据。字段缺失时邮件仍发送，并明确标注“暂无/未同步”，不编造、不补发。

## 需求表

| 模块 | 时间 | 数据口径 | 输出 | 去重 |
|---|---:|---|---|---|
| Ride Analysis | 每 30 分钟 | 最近骑行活动 | 单次骑行训练分析邮件 | `sent:{activityId}` |
| Morning Body Status | 北京时间 09:20 | 当日 wellness，重点看昨夜睡眠、HRV、静息心率 | 晨间身体状态邮件 | `sent:body:morning:YYYY-MM-DD` |
| Evening Body Brief | 北京时间 21:00 | 当日 wellness + 当天所有活动 | 晚间身体小报 | `sent:body:evening:YYYY-MM-DD` |

Cloudflare cron 使用 UTC：

- `*/30 * * * *`：骑行分析
- `20 1 * * *`：北京时间 09:20 晨报
- `0 13 * * *`：北京时间 21:00 晚报

## 手动测试接口

- `/run`：兼容旧入口，触发骑行分析。
- `/run/ride?dry=1&force=1&max=1`：骑行分析测试。
- `/run/body/morning?dry=1&force=1&date=YYYY-MM-DD`：晨报测试。
- `/run/body/evening?dry=1&force=1&date=YYYY-MM-DD`：晚报测试。

参数说明：

- `dry=1`：只返回预览，不发邮件、不写 KV。
- `force=1`：忽略去重，用于手动重发测试。
- `date=YYYY-MM-DD`：指定身体状态报告日期，不传则使用北京时间当天。

## 分析逻辑

晨报输出：

- 睡眠时长、7 日均值、睡眠差。
- HRV、静息心率、相对 7 日趋势。
- Intervals.icu wellness 中当前可读的 Oura/Garmin 字段：`sleepSecs`、`sleepScore`、`sleepQuality`、`avgSleepingHR`、`readiness`、`steps`、HRV、静息心率。
- `stress`、`Body Battery`、`active calories` 等字段如果未同步或为空，邮件中显示“暂无/未同步”。
- 今日状态：`🟢 可训练`、`🟡 保守推进`、`🟠 优先恢复`。
- 当日训练强度上限、补水、咖啡因、午休建议。

晚报输出：

- 当天所有活动数量、运动时长、训练负荷、强度、消耗。
- 当天压力/恢复相关 wellness 指标。
- 今天身体承受了什么、今晚怎么睡、明天怎么安排。
- 如果当天没有训练记录，不把“无训练”当作数据缺失，改为展示“日常活动与恢复日”，重点呈现步数、睡眠评分、准备度、HRV 和静息心率。

AI 逻辑：

- 使用 OpenAI Responses API，默认模型 `gpt-4.1-mini`。
- AI 只负责将结构化指标转成更自然的中文分析，不编造缺失字段。
- AI 调用失败时自动使用规则版 fallback，邮件仍发送。

手机端排版：

- 邮件使用单列布局，主内容宽度控制在适合 iPhone 的范围。
- 关键指标使用卡片而不是横向表格，避免手机端挤压和横向滚动。
- 摘要区尽量拆成短行，避免一行塞入过多指标。

## 验收标准

- `/health` 显示 `rideAnalysis` 和 `bodyStatus` 均为 `true`。
- 晨报 dry-run 返回 `previews[0].analysis.wellness` 与 `status`。
- 晚报 dry-run 返回 `previews[0].analysis.activity`、`wellness` 与 `status`。
- 不带 `force=1` 重复触发同一天晨报/晚报时跳过。
- 带 `force=1` 可以重发测试邮件。
- `.dev.vars`、日志和 `node_modules` 不进入 Git。

## 排期

1. 更新 Worker 路由和 cron 调度。
2. 新增身体状态数据汇总、状态判定、规则 fallback 与邮件模板。
3. 接入 OpenAI AI 分析复用层。
4. 本地 dry-run 验证骑行、晨报、晚报。
5. 部署 Cloudflare 并进行云端 dry-run。
6. 提交 Git commit；执行 `git push` 前必须先确认。
