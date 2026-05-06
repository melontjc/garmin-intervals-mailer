# Garmin / Oura -> Intervals.icu -> Email 分析助手

这是一个运行在 Cloudflare Workers 上的个人自动分析服务：

1. Garmin Connect / Oura Ring 数据同步到 Intervals.icu。
2. Worker 定时读取 Intervals.icu 的 activities 与 wellness 数据。
3. 如果配置了 Oura API token，Worker 会直接读取 Oura 官方恢复/睡眠/活动数据，并优先用于身体状态分析。
4. 生成骑行分析、晨间身体状态、晚间身体小报。
5. 通过 Resend 发到你的邮箱。

详细身体状态需求见 [docs/body-status-analysis.md](docs/body-status-analysis.md)。

## 功能模块

| 模块 | 触发时间 | 说明 |
|---|---:|---|
| 骑行分析 | 每 30 分钟 | 检查新骑行，发现未发送活动后生成 AI/规则分析邮件 |
| 晨间身体状态 | 工作日 09:20 / 休息日 10:00 | 按中国节假日与调休判断工作日/休息日 |
| 晚间身体小报 | 北京时间 23:00 | 汇总当天活动/运动负荷、压力和睡前/次日建议 |

## 你需要准备

- Intervals.icu 账号，并连接 Garmin Connect / Oura Ring。
- Intervals.icu API key。
- Oura Membership 与 Oura Personal Access Token，可选，但建议开启，用于读取更完整的睡眠和恢复数据。
- Cloudflare 账号。
- Resend 账号和 API key。
- OpenAI API key，用于 AI 总结；缺失或失败时会使用规则版 fallback。

## 本地配置

复制示例密钥文件：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`，填入：

- `INTERVALS_API_KEY`
- `INTERVALS_ATHLETE_ID`，先用 `0`
- `OURA_ACCESS_TOKEN`，可选；不填时继续只使用 Intervals.icu wellness
- `OPENAI_API_KEY`
- `OPENAI_MODEL`，默认 `gpt-4.1-mini`
- `RESEND_API_KEY`
- `RECIPIENT_EMAIL`
- `RESEND_FROM`

`.dev.vars` 已被 `.gitignore` 忽略，不能上传到 GitHub。

## 手动测试

安装依赖：

```powershell
npm.cmd install
```

骑行分析 dry-run：

```powershell
node scripts\local-run.mjs '/run/ride?dry=1&force=1&max=1'
```

晨间身体状态 dry-run：

```powershell
node scripts\local-run.mjs '/run/body/morning?dry=1&force=1&date=2026-05-02'
```

晨间工作日历 dry-run：

```powershell
node scripts\local-run.mjs '/run/body/morning/calendar?dry=1&date=2026-05-06&slot=workday'
```

晚间身体小报 dry-run：

```powershell
node scripts\local-run.mjs '/run/body/evening?dry=1&force=1&date=2026-05-02'
```

配置 Oura token 后，dry-run 返回的 `previews[0].analysis.wellness.source` 应显示 `oura-api+intervals`。如果 Oura 接口暂时不可用，会自动降级为 `intervals`，邮件仍然发送。

浏览器云端测试：

```text
https://garmin-intervals-mailer.tanjiachen1127.workers.dev/health
https://garmin-intervals-mailer.tanjiachen1127.workers.dev/run/ride?dry=1&force=1&max=1
https://garmin-intervals-mailer.tanjiachen1127.workers.dev/run/body/morning?dry=1&force=1
https://garmin-intervals-mailer.tanjiachen1127.workers.dev/run/body/morning/calendar?dry=1&date=2026-05-06&slot=workday
https://garmin-intervals-mailer.tanjiachen1127.workers.dev/run/body/evening?dry=1&force=1
```

## Cloudflare KV

KV 用于去重，避免重复发送邮件：

```powershell
npx.cmd wrangler kv namespace create SENT_ACTIVITIES
```

把输出的 `id` 填进 `wrangler.toml`。

## 部署

部署前把敏感密钥写入 Cloudflare Workers secrets：

```powershell
npx.cmd wrangler secret put INTERVALS_API_KEY
npx.cmd wrangler secret put OURA_ACCESS_TOKEN
npx.cmd wrangler secret put OPENAI_API_KEY
npx.cmd wrangler secret put RESEND_API_KEY
```

部署：

```powershell
npm.cmd run deploy
```

当前 cron：

```text
*/30 * * * *   骑行分析
20 1 * * *     北京时间 09:20 工作日晨报
0 2 * * *      北京时间 10:00 休息日晨报
0 15 * * *     北京时间 23:00 晚报
```
