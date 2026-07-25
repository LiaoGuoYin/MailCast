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

邮件目标不需要在 Email Routing 中逐个验证。MailCast 通过 Email Sending
把收到的邮件重新发送到任意有效邮箱；Cloudflare 向任意收件人发送要求 Workers Paid。

```bash
pnpm exec wrangler email sending enable example.com
pnpm exec wrangler email sending dns get example.com
pnpm exec wrangler email sending list example.com
```

按 Cloudflare 返回的信息完成发送域名的 SPF、DKIM 等 DNS 验证后，把下面配置加入
部署生成的仓库中的 `wrangler.toml`：

```toml
[[send_email]]
name = "EMAIL"
```

不要配置 `allowed_destination_addresses`，否则只能发送到列出的目标。发件地址按以下顺序选择：

1. MailCast 设置页面保存的地址。
2. 可选环境变量 `EMAIL_FROM_ADDRESS`。
3. 默认的 `forwarder@收到邮件的域名`。

默认地址不需要真实邮箱账号，但它所属的域名必须已经完成 Email Sending onboarding。
如需环境变量覆盖，可额外添加：

```toml
[vars]
EMAIL_FROM_ADDRESS = "notify@example.com"
```

提交配置后由 Workers Builds 自动部署，或在本地执行：

```bash
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

未配置 `EMAIL` binding 时，收件存储、Telegram 和 Bark 仍可使用；自动和手动邮件发送会返回明确的未配置错误。

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
