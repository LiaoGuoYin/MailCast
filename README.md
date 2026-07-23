# MailCast

MailCast 是一个运行在 Cloudflare Workers 上的自托管邮件路由与通知中心。它接收指定域名的邮件，保留可检索的邮件副本，并按收件前缀转发到邮箱、Telegram 或 Bark。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LiaoGuoYin/mailcast)

## 一键部署

1. 点击上方 **Deploy to Cloudflare**。
2. 登录 Cloudflare，并授权复制这个公开 GitHub 仓库。
3. 选择 Worker 和 D1 名称并开始部署。
4. 等待 Cloudflare 创建 D1、运行 migrations 并部署 Worker。
5. 打开生成的 `*.workers.dev` 地址，使用默认密码 `mailcast123` 首次登录，并按提示设置新密码。

首次登录完成强制改密前，MailCast 不会创建管理员会话。新密码只以带随机盐的 PBKDF2-SHA256 哈希保存在 D1；初始化完成后，默认密码立即失效。

> Deploy Button 要求源仓库公开。若从自己的副本分享部署按钮，请把按钮 URL 中的仓库地址替换为公开副本地址。

## 部署后配置邮件

Deploy Button 会自动创建 Worker、Static Assets、D1 和 Workers AI，但不会替你接管域名或修改邮件 DNS。要接收邮件，还需要在 Cloudflare 中：

1. 为自己的域名启用 Email Routing。
2. 将 Catch-all 或指定地址路由到部署出的 Worker。
3. 如果需要转发到邮箱，再启用 Email Sending，并在 Wrangler 配置中添加 `EMAIL` binding 和 `EMAIL_FROM_ADDRESS`。

域名授权、MX/DNS 和收件地址验证必须由域名所有者确认，因此无法由公开模板静默完成。完整步骤见 [部署指南](./DEPLOYMENT.md)。

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

不要把真实密码或 Token 提交到 Git。
