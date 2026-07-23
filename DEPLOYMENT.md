# MailCast 部署指南

MailCast 默认以公开 Deploy Button 模板运行。基础部署会创建 Worker、Static Assets、D1 和 Workers AI，并先使用 `workers.dev` 地址。Email Routing、Email Sending 和自定义域名在基础实例可访问后再配置。

## Deploy Button

公开仓库可以使用以下链接：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/LiaoGuoYin/mailcast
```

部署页面会读取 `wrangler.toml`：

- 自动创建并绑定新的 D1 数据库。
- 执行 `pnpm deploy`，先应用 D1 migrations，再部署 Worker。
- 创建用户自己的 GitHub 仓库并配置 Workers Builds。

完成后打开 Cloudflare 返回的 `*.workers.dev` 地址，使用默认密码 `mailcast123` 首次登录。系统会强制设置新密码，完成前不会创建管理员会话；新密码的加盐哈希写入 D1 后，默认密码立即失效。

## 手动部署

### 1. 创建 D1

```bash
pnpm install
pnpm exec wrangler login
pnpm exec wrangler d1 create mailcast --location apac
```

把命令返回的 ID 写入 `wrangler.toml` 的 `database_id`。模板中的全零 UUID 只用于 Deploy Button 识别和自动替换，不能直接用于手动远程部署。

### 2. 部署并首次登录

```bash
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

随后打开 Worker 地址，使用默认密码 `mailcast123` 登录并立即设置新密码。

也可以继续使用本地脚本直接写入 D1：

```bash
pnpm auth:set:remote
```

## 配置收件域名

先确认 Worker Web 控制台和 D1 可用，再启用 Email Routing。

主域名没有其他邮件服务时：

```bash
pnpm exec wrangler email routing enable example.com
pnpm exec wrangler email routing dns get example.com
```

主域名已有 MX 时，不要直接接管主域名；在 Cloudflare Dashboard 的 `Email Routing → Settings → Subdomains` 中启用独立收件子域名。

最后将 Catch-all 或指定地址设置为 `Send to a Worker`，目标选择部署出的 MailCast Worker。Cloudflare 不会重新投递切换前已经进入其他目标的邮件。

## 配置邮件转发

只有需要把存储的邮件再次发送到邮箱时，才需要 Email Sending。

```bash
pnpm exec wrangler email sending enable example.com
pnpm exec wrangler email sending dns get example.com
pnpm exec wrangler email sending list example.com
```

域名验证完成后，把下面配置加入 `wrangler.toml`：

```toml
[vars]
EMAIL_FROM_ADDRESS = "forwarder@example.com"

[[send_email]]
name = "EMAIL"
allowed_sender_addresses = ["forwarder@example.com"]
```

发件地址的域名必须已经完成 Email Sending onboarding。自动转发的目标邮箱也必须先在 Email Routing 中验证。

```bash
pnpm exec wrangler email routing addresses create target@example.net
pnpm exec wrangler email routing addresses list
pnpm deploy
```

未配置 Email Sending 时，收件存储、Telegram 和 Bark 仍可使用；邮件转发会返回明确的未配置错误。

## 自定义控制台域名

基础部署稳定后，可以加入自己的 Custom Domain：

```toml
routes = [
  { pattern = "mail.example.com", custom_domain = true },
]
```

重新部署前确认该主机名没有需要保留的 CNAME 或其他 Worker route。

## 验收

```bash
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
curl -I https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
```

再投递一封受控测试邮件，确认：

- 收件箱能查看 HTML、纯文本和 Raw。
- Telegram、Bark 或邮件转发状态符合配置。
- 管理密码、Bot Token 和 API Key 未出现在代码、日志或 Git 历史中。

## 参考

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Email Routing](https://developers.cloudflare.com/email-service/get-started/route-emails/)
- [Email Sending Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
