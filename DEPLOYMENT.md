# MailCast 部署指南

MailCast 默认以公开 Deploy Button 模板运行。基础部署会创建 Worker、Static Assets、D1 和 Workers AI，并先使用 `workers.dev` 地址。Email Routing、Resend 发信和自定义域名在基础实例可访问后再配置。

## Deploy Button

公开仓库可以使用以下链接：

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/LiaoGuoYin/mailcast
```

部署页面会读取 `wrangler.toml`：

- 自动创建并绑定新的 D1 数据库。
- 执行 `pnpm deploy`，先应用 D1 migrations，再部署 Worker。
- 创建用户自己的 GitHub 仓库并配置 Workers Builds。

部署时如提示配置 `ADMIN_PASSWORD`，请填写自己的管理员密码。若 Worker 已创建但未配置密码，按下方“管理密码与忘记密码”在 Cloudflare 控制台设置 Secret 并部署，再打开 `*.workers.dev` 登录。

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
pnpm deploy:dry-run
pnpm deploy
```

部署脚本会使用 `package.json` 版本号和当前 Git commit 为 Worker Version 打 tag；控制台底部据此显示线上版本、Commit 和部署时间。Workers Builds 自动提供 Commit SHA，本地手动部署则读取当前 Git HEAD，并要求先提交所有改动，避免线上代码与显示的 Commit 不一致。

部署前，为目标 Worker 配置 `ADMIN_PASSWORD` Secret；已有 Worker 可直接按下方步骤设置。首次手动部署若尚未创建 Worker，可先在 Cloudflare 网页创建同名 Worker 并设置 Secret，再运行部署命令。部署后使用该密码登录。

## 管理密码与忘记密码

管理员密码唯一来源是 Worker 运行时的 `ADMIN_PASSWORD` **Secret**，不是 Workers Builds 的构建变量，也不是普通 Text 变量。

1. 打开 Cloudflare → **Workers & Pages**，选择自己的 MailCast Worker。
2. 进入 **Settings → Variables and Secrets**。
3. 添加或编辑 `ADMIN_PASSWORD`，类型选择 **Secret**，输入新密码（8–256 位，不含空白字符）。
4. 保存并 **Deploy**，确保携带新 Secret 的版本承接全部生产流量。
5. 回到 MailCast，用新密码登录。忘记密码时重复以上步骤，无需旧密码或终端。

Secret 保存后无法回显，请使用密码管理器保存。未配置或配置无效时，管理 API 拒绝访问，登录页提示配置密码；邮件接收不依赖管理员密码。

MailCast 内不再提供改密入口。D1 只保存与当前 Secret 绑定的随机会话校验值，不保存新的管理员密码哈希。改成不同的新密码后，旧会话无法在新版本中验证；旧记录会在过期清理时移除。重新使用原来的密码或回滚到携带旧 Secret 的版本，可能使尚未过期的对应会话恢复有效，因此重置时应使用全新的密码，并切换全部流量。

### 从 D1 密码迁移

升级前先在现有 Worker 上配置 `ADMIN_PASSWORD` Secret，再部署本版本。旧版代码仍使用原 D1 密码；新代码上线后只接受 Secret 中的密码，旧登录会话失效。D1 中已有的 `settings.auth_token` 不再读取，无需手动删除，也无需新增数据库迁移。旧 `auth:set:*` 命令及写入 D1 的脚本已移除。

## 配置收件域名

先确认 Worker Web 控制台和 D1 可用，再启用 Email Routing。

主域名没有其他邮件服务时：

```bash
pnpm exec wrangler email routing enable example.com
pnpm exec wrangler email routing dns get example.com
```

主域名已有 MX 时，不要直接接管主域名；在 Cloudflare Dashboard 的 `Email Routing → Settings → Subdomains` 中启用独立收件子域名。

最后将 Catch-all 或指定地址设置为 `Send to a Worker`，目标选择部署出的 MailCast Worker。Cloudflare 不会重新投递切换前已经进入其他目标的邮件。

## 配置邮件转发（默认 Resend）

邮件目标不需要在 Email Routing 中逐个验证。MailCast 默认通过 Resend API，把收到的邮件重新发送到任意有效邮箱。每个 MailCast 实例建议使用独立的 Resend 发信域名和 API Key，后续停用或轮换时不会影响其他实例。

下面以这组配置为例：

```text
控制台地址：https://mail.example.com
Resend 发信域名：mail.example.com
发件地址：forwarder@mail.example.com
```

控制台地址和发信域名可以不同。这里使用相同地址只是为了减少需要维护的域名。

### 1. 确认 Resend 域名额度

在 Resend 的 Domains 页面查看当前套餐还能添加多少个域名。如果额度已满，可以删除不再使用的域名，或升级套餐后保留多个域名。套餐价格和额度可能调整，以 Resend 页面显示为准。

删除旧域名前先确认没有其他应用仍在用它发信。删除后，以该域名为 From 的邮件不能继续发送；只限定到该域名的 API Key 也应一并删除。

### 2. 添加发信域名

在 Resend 中添加：

```text
mail.example.com
```

这里验证的是完整的发信域名。后续发件地址必须使用同一个域名，例如 `forwarder@mail.example.com`，不能改成 `forwarder@example.com`。

Resend Inbound 与 MailCast 收信无关，不要启用。收信仍由 Cloudflare Email Routing 负责。

### 3. 添加 Resend 生成的 DNS 记录

Resend 会为新域名生成 SPF、DKIM 和 Return-Path 记录。常见形式如下，表中的名称只用于说明结构：

| 类型 | Cloudflare 中常见的名称 | 内容 |
| --- | --- | --- |
| MX | `send.mail` | 复制 Resend 生成的目标和优先级 |
| TXT | `send.mail` | 复制 Resend 生成的 SPF |
| TXT | `resend._domainkey.mail` | 复制 Resend 生成的 DKIM 公钥 |

在 Cloudflare 的 `example.com` DNS 区域中添加这些记录，TTL 保持 `Auto`。名称和内容必须以 Resend 当前页面生成的值为准，不要从本文或其他域名复制。Cloudflare 输入框使用相对名称时填 `send.mail`；如果填完整域名，要确认没有被拼成 `send.mail.example.com.example.com`。

不要修改 `example.com` 根域现有的 MX，也不要删除 Cloudflare Email Routing 的收件记录。Resend 的 MX 位于 `send.mail.example.com`，只负责退信和 Return-Path，不会接管根域收信。

如果相同名称和类型的记录已经存在，先比较用途和内容，不要直接覆盖。添加完成后可以检查权威 DNS：

```bash
dig +short MX send.mail.example.com
dig +short TXT send.mail.example.com
dig +short TXT resend._domainkey.mail.example.com
```

回到 Resend 刷新状态，等域名显示为 `Verified` 后再继续。DNS 控制台中已经出现记录，不代表 Resend 的查询节点已经同步。

### 4. 创建实例专用 API Key

域名验证通过后创建 API Key：

```text
Name: MailCast Production
Permission: Sending access
Domain: mail.example.com
```

如果同一账户运行多个 MailCast 实例，为每个实例单独创建 Key，并限制到各自的域名。不要把 Key 写进仓库、终端命令、部署日志或聊天记录。Resend 只在创建时显示完整 Key，打开 MailCast 设置页面后直接粘贴。

### 5. 保存 MailCast 发信设置

登录 MailCast，打开“设置 → 邮件发送”，填写：

```text
Provider: Resend
API Key: re_...
发件地址：forwarder@mail.example.com
```

发件地址字段只填写邮箱地址。发送时 MailCast 会自动使用 `MailCast` 作为显示名称，最终的 From 为：

```text
MailCast <forwarder@mail.example.com>
```

Resend API Key 会以明文保存在当前实例的 D1 `settings` 表中，管理 API 和网页不会再次返回完整 Key。请限制管理员访问并保护 D1 导出和备份。

Resend 的免费套餐有月度和每日发送上限，具体额度以套餐页面为准。全收域名收到的垃圾邮件可能触发大量转发并快速消耗额度。

发件地址按以下顺序选择：

1. MailCast 设置页面保存的地址。
2. 可选环境变量 `EMAIL_FROM_ADDRESS`。
3. 默认的 `forwarder@收到邮件的域名`。

默认地址不需要真实邮箱账号，但它所属的域名必须已经在 Resend 完成验证。如需环境变量覆盖，可在 `wrangler.toml` 添加：

```toml
[vars]
EMAIL_FROM_ADDRESS = "notify@example.com"
```

未配置 Resend API Key 时，收件存储、Telegram 和 Bark 仍可使用；自动和手动邮件发送会记录为失败并提示进入设置页完成配置。

### 6. 验收收取、保存和转发

从外部邮箱向 MailCast 管理的地址发送一封真实邮件，依次确认：

1. Cloudflare Email Routing 将邮件交给 MailCast Worker。
2. MailCast 邮件列表中能看到 HTML、纯文本和 Raw。
3. 下游记录显示邮件转发成功，没有 Resend 错误。
4. 目标邮箱收到转发邮件，From 域名为 `mail.example.com`。

还可以在目标邮件头中检查 SPF、DKIM 和 DMARC。SPF、DKIM 应通过，DKIM 域名应与 `mail.example.com` 对齐。

DMARC 不属于 Resend 域名验证的必填记录。需要观察投递情况时，可以为 `_dmarc.mail.example.com` 添加 `p=none` 策略并接收报告；报告稳定前不要直接改成 `quarantine` 或 `reject`。DMARC 内容和报告地址应由当前域名的管理工具生成，不要复制其他域名的 `rua` 地址。

### 常见问题

- **`The mail.example.com domain is not verified`**：Resend 尚未把该域名标记为 `Verified`，或 MailCast 的发件地址使用了另一个域名。检查 Resend Domains 页面、三条 DNS 记录和发件地址后重试。
- **`The example.com domain is not verified`**：发件地址很可能写成了 `forwarder@example.com`。如果 Resend 验证的是 `mail.example.com`，发件地址也必须以 `@mail.example.com` 结尾。
- **Resend 一直显示 Pending**：分别查询 MX、SPF 和 DKIM 的完整域名，确认记录发布到了正确的 Cloudflare DNS 区域，名称没有重复拼接，内容也没有多余引号或截断。
- **邮件能保存但转发失败**：收信和转发是两条独立链路。先在 MailCast 下游记录中查看 Resend 返回的错误，再检查 API Key 权限、域名限制、发件地址和套餐额度。

## 可选：Cloudflare Email Sending

如果已经使用 Workers Paid，也可以在 MailCast 设置中选择 Cloudflare Email Sending。先启用并验证发送域名：

```bash
pnpm exec wrangler email sending enable example.com
pnpm exec wrangler email sending dns get example.com
pnpm exec wrangler email sending list example.com
```

然后把 binding 加入 `wrangler.toml`：

```toml
[[send_email]]
name = "EMAIL"
```

不要配置 `allowed_destination_addresses`，否则只能发送到列出的目标。部署完成后，在 MailCast“设置 → 邮件发送”中显式选择 Cloudflare。

提交配置后由 Workers Builds 自动部署，或在本地执行：

```bash
pnpm exec wrangler deploy --dry-run
pnpm deploy
```

MailCast 不会在 Resend 和 Cloudflare 之间自动故障切换，避免供应商已经接收请求但响应超时时产生重复邮件。

## 从旧版本升级

本版本将默认发送服务改为 Resend。旧数据库中没有 `email_provider` 设置时也会选择 Resend，已有的 `EMAIL` binding 不会自动兜底。升级前请先准备 Resend 域名和 API Key；升级后登录设置页保存，或显式改选 Cloudflare Email Sending。

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
- [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend Pricing](https://resend.com/pricing)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
