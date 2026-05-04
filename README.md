# Garmin -> Intervals.icu -> Email 骑行分析

这是一套轻量 Cloudflare Worker 模板：

1. Garmin Connect 自动同步骑行到 Intervals.icu。
2. Worker 每 30 分钟查询最近骑行。
3. 对未发送过的骑行生成中文总结和恢复建议。
4. 通过 Resend 发到你的邮箱。

## 你需要准备

- Intervals.icu 账号，并连接 Garmin Connect。
- Intervals.icu API key。
- Cloudflare 账号。
- Resend 账号和 API key。

## 本地配置

复制示例密钥文件：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

然后编辑 `.dev.vars`，填入：

- `INTERVALS_API_KEY`
- `INTERVALS_ATHLETE_ID`，先用 `0`；如果测试失败，改成 Intervals.icu URL 中的 athlete id
- `OPENAI_API_KEY`，用于生成 AI 教练分析；不填时会自动使用规则版分析
- `OPENAI_MODEL`，默认 `gpt-4.1-mini`
- `RESEND_API_KEY`
- `RECIPIENT_EMAIL`
- `RESEND_FROM`

## Cloudflare KV

创建 KV 命名空间，用来记录已经发过邮件的活动，避免重复发送：

```powershell
npx wrangler kv namespace create SENT_ACTIVITIES
```

把命令输出里的 `id` 填进 `wrangler.toml`。

## 本地测试

```powershell
npm install
npm run local-run
```

只预览、不发邮件：

```powershell
npm run local-run -- "/run?dry=1&max=1"
```

强制重发最近一条，用来测试邮件模板：

```powershell
npm run local-run -- "/run?force=1&max=1"
```

启动 Worker 开发服务器：

```powershell
npm run dev
```

另开一个终端触发定时任务：

```powershell
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

也可以访问：

```text
http://localhost:8787/health
```

## 部署

部署前把敏感密钥写入 Cloudflare Workers secrets：

```powershell
npx wrangler secret put INTERVALS_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put RESEND_API_KEY
```

部署：

```powershell
npm run deploy
```

部署后 Worker 会按 `wrangler.toml` 中的 cron 每 30 分钟运行一次。
