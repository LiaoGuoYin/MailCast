# MailCast

MailCast 是一个运行在 Cloudflare Workers 上的自托管邮件路由与通知中心。它接收指定域名的邮件，保留可检索的邮件副本，并按收件前缀转发到邮箱、Telegram 或 Bark。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LiaoGuoYin/mailcast)

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 登录 Cloudflare，并授权复制这个公开 GitHub 仓库。
3. 选择 Worker 和 D1 名称并开始部署。
4. 等待 Cloudflare 创建 D1、运行 migrations 并部署 Worker。
5. 在 Worker 的 **Settings → Variables and Secrets** 添加 **Secret**：`ADMIN_PASSWORD`，设置自己的密码并部署；如果部署页面已要求填写该 Secret，可直接使用。
6. 打开生成的 `*.workers.dev` 地址，使用该密码登录。

管理密码仅由 `ADMIN_PASSWORD` Secret 决定，要求 8–256 位且不含空白字符，没有默认密码。忘记密码时，在 Cloudflare 网页修改该 Secret 并部署即可，无需终端。使用不同的新密码后，旧会话失效。详见[密码配置与重置](./DEPLOYMENT.md#管理密码与忘记密码)。

> Deploy Button 要求源仓库公开。若从自己的副本分享部署按钮，请把按钮 URL 中的仓库地址替换为公开副本地址。

## 部署后配置邮件

Deploy Button 会自动创建 Worker、Static Assets、D1 和 Workers AI，但不会替你接管域名或修改邮件 DNS。要接收邮件，还需要在 Cloudflare 中：

1. 为自己的域名启用 Email Routing。
2. 将 Catch-all 或指定地址路由到部署出的 Worker。
3. 在 Resend 添加独立发信域名，把 Resend 生成的 MX、SPF 和 DKIM 记录加入 Cloudflare。
4. 等域名显示为 `Verified`，再创建仅允许发信且限定到该域名的 API Key。
5. 登录 MailCast，在“设置 → 邮件发送”中保存 API Key 和同域发件地址，再点“发送测试邮件”确认能发出。

登录后收件箱顶部的“开始使用”清单会自动检测以上步骤：收到第一封邮件、添加路由规则、配置邮件发送（仅当有规则转发到邮箱时需要），全部完成后自动隐藏。只用 Telegram 或 Bark 时，第 3–5 步可以跳过。

比如验证 `mail.example.com` 后，发件地址应使用 `forwarder@mail.example.com`，不能使用 `forwarder@example.com`。不要修改根域 MX，也不要启用 Resend Inbound；MailCast 收信仍由 Cloudflare Email Routing 负责。

MailCast 默认通过 Resend 重新发送，目标邮箱无需逐个验证。也可改用 Cloudflare Email Sending，但向任意目标发信需要 Workers Paid 和 `EMAIL` binding。发送域名授权以及 SPF、DKIM 等 DNS 修改必须由域名所有者确认，因此无法由公开模板静默完成。域名额度处理、DNS 核验、API Key 安全和真实邮件验收见 [部署指南](./DEPLOYMENT.md#配置邮件转发默认-resend)。

## 功能

- 通过 Cloudflare Email Routing 接收域名邮件
- 默认通过 Resend API 发信，可选 Cloudflare Email Sending
- 使用 D1 保存邮件、路由规则和应用配置
- 按收件前缀一对多发送到任意有效邮箱、Telegram 或 Bark
- 路由页按收件地址列出每个出口及最近一次投递结果，手机上也能一眼看清
- 在 Web 控制台中查看邮件、管理目标和追踪投递状态
- Telegram 与 Bark 推送自动清洗 HTML/CSS 噪声并精简为摘要；可选使用 Cloudflare Workers AI 或 OpenAI 兼容接口提取验证码并生成 AI 摘要

## 本地开发

把 `.dev.vars.example` 复制为被 Git 忽略的 `.dev.vars`，把 `ADMIN_PASSWORD` 改成你自己的本地开发密码（8–256 位，不含空白字符），然后运行：

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm db:init:local
pnpm dev
```

控制台前端源码是 `web/` 下的 TypeScript，`pnpm dev` 和每次部署都会先把它编译到 `public/`；编译产物不入库，需要单独编译时运行 `pnpm build`。

Workers AI binding 在本地也会连接远程服务，所以 `pnpm dev` 需要先 `wrangler login`。如果登录的账号下有多个 Cloudflare 账户，再指定其中一个：`CLOUDFLARE_ACCOUNT_ID=<账户 ID> pnpm dev`。

不要把真实密码或 Token 提交到 Git。
