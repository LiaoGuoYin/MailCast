# MailCast

MailCast 是一个运行在 Cloudflare Workers 上的自托管邮件路由与通知中心。它接收指定域名的邮件，保留可检索的邮件副本，并按收件前缀转发到邮箱、Telegram 或 Bark。

## 功能

- 通过 Cloudflare Email Routing 接收域名邮件
- 使用 D1 保存邮件、路由规则和应用配置
- 按收件前缀一对多转发到邮箱、Telegram 或 Bark
- 在 Web 控制台中查看邮件、管理目标和追踪投递状态
- 可选使用 Cloudflare Workers AI 或 OpenAI 兼容接口提取验证码

## 本地开发

```bash
pnpm install
pnpm db:init:local
pnpm auth:set:local
pnpm dev
```

部署新实例前，请阅读 [MailCast Agent 部署指南](./DEPLOYMENT.md)。
