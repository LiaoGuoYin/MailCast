# MailCast

MailCast 是一个运行在 Cloudflare Workers 上的自托管邮件路由与通知服务，用于接收指定域名的邮件并按规则分发。

- 保留原始邮件，将邮件转发到个人邮箱（有一个 web，可以用于配置邮件对应关系，可一对多）
比如 <github@xxx.com> 转发到 <makecoin@icloud.com>
<gpt@xxx.com> 转发给 <makecoin@icloud.com> <withcoin@qq.com>

- 能看到所有进来的邮件，并存储到 cf d1 数据库中
- 按收件前缀路由到不同 Telegram 用户组（支持一转多）
- 可选通过 Cloudflare Workers AI 提取验证码并推送
