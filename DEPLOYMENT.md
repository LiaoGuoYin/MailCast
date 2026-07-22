# MailCast Agent 部署指南

目标：把当前项目部署到新的 Cloudflare 账户，并完成收件、发件、D1 和管理后台配置。默认创建全新实例，不迁移旧数据。

## 执行约束

- 只修改 `wrangler.toml` 和重新生成的 `src/worker-configuration.d.ts`。不要改业务代码。
- 不覆盖工作区已有改动，不提交或推送，除非用户明确要求。
- 不输出、记录或写入 Git：管理密码、Telegram Bot Token、OpenAI API Key。
- 切换 Email Routing 的 Catch-all 前，必须确认目标 Worker 已部署并能访问。
- 主域名已有 MX 时，不接管主域名，改用独立收件子域名。
- 任何命令失败都停止后续部署，保留原路由并报告完整错误。

## 向用户获取

| 变量 | 示例 |
| --- | --- |
| Cloudflare 账户 | 目标 Account ID 或账户名 |
| Zone | `example.com` |
| 控制台域名 | `router.example.com` |
| 收件域名 | `example.com` 或 `inbox.example.com` |
| 发件地址 | `forwarder@example.com` |

固定名称：

```text
Worker: mailcast
D1: mailcast
Bindings: DB, AI, EMAIL
```

完整功能需要 Workers、Static Assets、D1、Email Routing 和 Email Sending。Workers AI 可选。管理密码、Telegram Bot 和 OpenAI 配置写入 D1，其中管理密码只保存带随机盐的 PBKDF2 哈希。

## 1. 检查账户与仓库

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler whoami
git status --short
```

确认 `wrangler whoami` 指向目标账户。保留 `git status` 中已有的用户改动。

## 2. 创建 D1 并修改配置

```bash
pnpm exec wrangler d1 create mailcast --location apac
```

把返回的 `database_id` 和用户提供的域名写入 `wrangler.toml`：

```toml
routes = [
  { pattern = "router.example.com", custom_domain = true },
]

[vars]
EMAIL_FROM_ADDRESS = "forwarder@example.com"

[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["forwarder@example.com"]

[[d1_databases]]
binding = "DB"
database_name = "mailcast"
database_id = "<NEW_D1_DATABASE_ID>"
migrations_dir = "migrations"
```

保持现有 `assets` 和 `[ai]` 配置不变，然后执行：

```bash
pnpm cf-typegen
pnpm db:migrate:remote
pnpm exec wrangler d1 migrations list mailcast --remote
pnpm auth:set:remote
```

迁移列表应不再显示待执行项。`auth:set:remote` 必须在交互式终端执行，密码不会显示，也不会作为命令参数传递。

## 3. 配置邮件域名

主域名没有现有邮件服务时：

```bash
pnpm exec wrangler email routing enable example.com
pnpm exec wrangler email routing dns get example.com
```

主域名已有 MX 时，在 Dashboard 的 `Email Routing → Settings → Subdomains` 中启用收件子域名，不执行上面的主域名接管命令。

启用发件域名：

```bash
pnpm exec wrangler email sending enable example.com
pnpm exec wrangler email sending dns get example.com
pnpm exec wrangler email sending list example.com
```

发件域名必须和 `EMAIL_FROM_ADDRESS` 的域名一致。等待 Cloudflare 显示所需 DNS 记录已经生效。

自动转发的目的邮箱需要逐个验证：

```bash
pnpm exec wrangler email routing addresses create target@example.net
pnpm exec wrangler email routing addresses list
```

## 4. 验证并部署

```bash
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

部署后检查控制台：

```bash
curl -I https://router.example.com
```

预期能建立 HTTPS 连接，且响应不是 Cloudflare 路由错误。若 Custom Domain 与现有 CNAME 冲突，停止并让用户决定如何处理该 DNS 记录。

## 5. 切换入站邮件

仅在 Worker、D1、管理密码和控制台都验证成功后执行：

```bash
pnpm exec wrangler email routing rules update example.com catch-all \
  --enabled true \
  --action-type worker \
  --action-value mailcast

pnpm exec wrangler email routing rules get example.com catch-all
```

使用收件子域名时，在 Dashboard 将该子域名的 Catch-all 设置为 Send to a Worker，目标选择 `mailcast`。

Cloudflare 不会把切换前收到的邮件重新投递给新 Worker。

## 6. 配置应用

登录控制台后完成：

1. 添加并测试 Telegram Bot。
2. 选择验证码提取方式。使用 OpenAI 兼容接口时填写 Base URL、API Key 和模型。
3. 新建 Telegram 和邮件转发规则。

这些配置保存在 D1。管理密码始终以 PBKDF2-SHA256 哈希保存在 `settings.auth_token`，不存在 Worker Secret 回退。

## 7. 验收

投递一封受控 HTML 邮件并检查：

- 收件箱出现邮件，HTML、纯文本和 Raw 能打开。
- Telegram 和自动转发下游状态正确。
- 手动重试需要二次确认且能记录新结果。
- 快速转发能到达受控邮箱。

```bash
pnpm exec wrangler d1 execute mailcast --remote \
  --command "SELECT id, to_addr, subject, created_at FROM emails ORDER BY id DESC LIMIT 5"

pnpm exec wrangler tail mailcast
```

验收完成后向用户报告：账户、Worker、控制台域名、D1、收件域名、发件域名、Catch-all 状态和测试结果。不要报告任何密钥值。

## 旧数据迁移

只有用户明确要求时才迁移旧 D1。完整备份包含邮件、Telegram Token、OpenAI Key 和管理密码哈希。导入前先制定单独迁移方案，不把完整备份导入已经执行过 migrations 的数据库。

## 参考

- [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Email Sending Binding](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
