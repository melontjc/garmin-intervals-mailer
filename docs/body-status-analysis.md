# 身体状态分析师功能模块需求文档

## 需求概览

在现有 Cloudflare Worker 中新增 **Body Status Analysis** 功能模块，与现有 **Ride Analysis** 并列运行。骑行分析继续每 30 分钟检查新骑行并发送邮件；身体状态模块每天发送两封邮件：

- 晨间身体状态分析：工作日北京时间 09:20 发送，休息日北京时间 10:00 发送；按中国节假日和调休日判断工作日/休息日。
- 晚间身体小报：北京时间 23:00，分析当天活动/运动负荷、压力和恢复趋势。

训练数据继续使用已经同步至 Intervals.icu 的 Garmin 与功率计数据。身体恢复数据优先使用 Oura 官方 API；如果未配置 Oura token 或接口失败，则自动降级使用 Intervals.icu wellness。字段缺失时邮件仍发送，并明确标注“暂无/未同步”，不编造、不补发。

## 需求表

| 模块 | 时间 | 数据口径 | 输出 | 去重 |
|---|---:|---|---|---|
| Ride Analysis | 每 30 分钟 | 最近骑行活动 | 单次骑行训练分析邮件 | `sent:{activityId}` |
| Morning Body Status | 工作日 09:20 / 休息日 10:00 | 中国节假日与调休日历 + Oura 睡眠/恢复 | 晨间身体状态邮件 | `sent:body:morning:YYYY-MM-DD` |
| Evening Body Brief | 北京时间 23:00 | Oura 全天活动/恢复 + Intervals.icu 当天所有运动 | 晚间身体小报 | `sent:body:evening:YYYY-MM-DD` |

Cloudflare cron 使用 UTC：

- `*/30 * * * *`：骑行分析
- `20 1 * * *`：北京时间 09:20 工作日晨报
- `0 2 * * *`：北京时间 10:00 休息日晨报
- `0 15 * * *`：北京时间 23:00 晚报

## 手动测试接口

- `/run`：兼容旧入口，触发骑行分析。
- `/run/ride?dry=1&force=1&max=1`：骑行分析测试。
- `/run/body/morning?dry=1&force=1&date=YYYY-MM-DD`：晨报测试。
- `/run/body/morning/calendar?dry=1&date=YYYY-MM-DD&slot=workday|restday`：晨报工作日历测试。
- `/run/body/evening?dry=1&force=1&date=YYYY-MM-DD`：晚报测试。

参数说明：

- `dry=1`：只返回预览，不发邮件、不写 KV。
- `force=1`：忽略去重，用于手动重发测试。
- `date=YYYY-MM-DD`：指定身体状态报告日期，不传则使用北京时间当天。

## 分析逻辑

晨报输出：

- 睡眠时长、7 日均值、睡眠差。
- HRV、静息心率、相对 7 日趋势。
- Oura API 优先字段：睡眠评分、总睡眠、睡眠效率、深睡、REM、清醒时间、睡眠均心率、最低睡眠心率、平均 HRV、准备度、体温偏离、呼吸率、步数、活动评分、活动热量、久坐/低中高强度活动时间。
- Intervals.icu wellness 兜底字段：`sleepSecs`、`sleepScore`、`sleepQuality`、`avgSleepingHR`、`readiness`、`steps`、HRV、静息心率。
- Oura 压力字段按时长展示：高压力时长、恢复时长、当日摘要；`stress_high = 0` 代表有效的“无高压力时段”，不视为缺失。
- `Body Battery` 是 Garmin 生态字段，不作为 Oura 身体状态报告的关键缺失项展示。
- 今日状态：`🟢 可训练`、`🟡 保守推进`、`🟠 优先恢复`。
- 当日训练强度上限、补水、咖啡因、午休建议。

晚报输出：

- 当天所有活动数量、运动时长、训练负荷、强度、消耗。
- 当天压力/恢复相关 wellness 指标。
- 今天身体承受了什么、今晚怎么睡、明天怎么安排。
- 如果当天没有训练记录，不把“无训练”当作数据缺失，改为展示“日常活动与恢复日”，重点呈现步数、睡眠评分、准备度、HRV 和静息心率。

AI 逻辑：

- 使用 OpenAI Responses API，默认模型 `gpt-4.1-mini`。
- AI 不复刻 Oura App 汇报，不只复述睡眠评分；重点做 Oura 恢复信号与 Intervals.icu/Garmin 训练负荷之间的整合判断。
- AI 输出当天/次日训练安排、恢复优先级和冲突判断，例如 “Oura readiness 尚可，但近期训练负荷偏高，所以保守推进”。
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

## 中国工作日历

2026 年节假日与补班日按国务院办公厅官方安排内置：

- 元旦：1 月 1 日至 3 日放假，1 月 4 日补班。
- 春节：2 月 15 日至 23 日放假，2 月 14 日、2 月 28 日补班。
- 清明节：4 月 4 日至 6 日放假。
- 劳动节：5 月 1 日至 5 日放假，5 月 9 日补班。
- 端午节：6 月 19 日至 21 日放假。
- 中秋节：9 月 25 日至 27 日放假。
- 国庆节：10 月 1 日至 7 日放假，9 月 20 日、10 月 10 日补班。

未维护年份会自动退回普通规则：周一至周五为工作日，周六周日为休息日。

## 排期

1. 更新 Worker 路由和 cron 调度。
2. 新增身体状态数据汇总、状态判定、规则 fallback 与邮件模板。
3. 接入 OpenAI AI 分析复用层。
4. 本地 dry-run 验证骑行、晨报、晚报。
5. 部署 Cloudflare 并进行云端 dry-run。
6. 提交 Git commit；执行 `git push` 前必须先确认。
