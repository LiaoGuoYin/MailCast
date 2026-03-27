# Coin Email Router (Cloudflare Worker)

一个 Cloudflare Email Worker，用于：

- 保留原始邮件转发到个人邮箱
- 按收件前缀路由到不同 Telegram 用户组（支持一转多）
- 可选通过 Workers AI 提取验证码并优先通知

## 1. 准备

1. 创建 Telegram Bot，拿到 `TELEGRAM_BOT_TOKEN`
2. 获取目标用户/群组 `chat_id`
3. 开启 Cloudflare Email Routing，并把目标域名邮件交给该 Worker

## 2. 配置

在 `wrangler.toml` 中设置：

- `DEFAULT_FORWARD_EMAIL`: 默认邮箱转发目标
- `ENABLE_AI_EXTRACT`: 是否开启 AI 提取
- `AI_MODEL_NAME`: Workers AI 模型
- `AI_TIMEOUT_MS`: AI 调用超时

并使用 secret 设置：

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ADMIN_API_TOKEN
```

建议配置两个 KV：

- `MAIL_CACHE`: `message-id` 去重
- `ROUTE_CONFIG_STORE`: 在线路由配置存储（唯一配置源）

## 3. 路由配置示例

```json
{
  "default": {
    "telegramChats": ["123456789"],
    "emails": []
  },
  "routes": [
    {
      "prefix": "github+",
      "telegramChats": ["123456789", "987654321"],
      "emails": ["dev-team@example.com"]
    },
    {
      "prefix": "binance+",
      "telegramChats": ["333333333"],
      "emails": []
    }
  ]
}
```

## 4. 本地开发与部署

```bash
npm install
npm run check
npm test
npm run dev
npm run deploy
```

## 5. 管理与排障

- `GET /healthz`: 健康检查
- `GET /routes`: 当前路由 JSON（优先读 KV）
- `PUT /routes`: 更新路由配置（需要 Bearer Token）
- `POST /debug/trigger-email`: 手动触发“收到邮件后的链路”（需要 Bearer Token）
- `GET /admin`: 简易配置展示页面

更新路由示例：

```bash
curl -X PUT "https://<your-worker>/routes" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ADMIN_API_TOKEN>" \
  --data '{
    "default": {"telegramChats": ["123456789"], "emails": []},
    "routes": [
      {"prefix":"github+","telegramChats":["123456789","987654321"],"emails":[]}
    ]
  }'
```

调试触发示例（不真实发信，默认不执行 email forward）：

```bash
curl -X POST "https://<your-worker>/debug/trigger-email" \
  -H "content-type: application/json" \
  -H "authorization: Bearer <ADMIN_API_TOKEN>" \
  --data '{
    "to": "github+debug@your-domain.com",
    "subject": "OTP Debug",
    "text": "Your code is 123456",
    "skipForward": true
  }'
```

日志会输出结构化字段：`messageId`, `routeKey`, `tgTargets`, `aiStatus`, `forwardStatus`, `errors`。

## 6. 回滚建议

1. 保留上一版本 Worker 部署记录
2. 异常时先关闭 `ENABLE_AI_EXTRACT`
3. 必要时回滚到上一版本并仅保留 email 转发
