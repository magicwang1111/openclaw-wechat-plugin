---
name: wecom-helper
description: 企业微信助手技能 - 帮助用户通过企业微信渠道进行沟通和协作
metadata: {"openclaw":{"emoji":"💬","channel":"openclaw-wechat"}}
---

# 企业微信助手 Skill

这个 skill 帮助 AI 更好地理解和处理企业微信相关的任务。

## 何时激活此 Skill

当用户：
- 提到"企业微信"、"WeCom"、"微信工作"
- 要求发送企业微信消息
- 询问企业微信相关配置
- 需要通过企业微信进行通知或提醒

## 企业微信渠道信息

### 配置参数
- **corpid**: 企业 ID（从企业微信管理后台获取）
- **corpsecret**: 应用 Secret
- **token**: 应用 Token（用于消息验证）
- **encodingAESKey**: 消息加密密钥

### API 端点
- **接收消息**: `POST /openclaw-wechat/message`
- **轮询消息**: `GET /openclaw-wechat/messages?email=xxx`

## 使用场景示例

### 场景 1: 发送通知
用户请求："给张三发一条企业微信消息，提醒他明天的会议"

响应思路：
1. 确认收件人标识（通常是企业微信账号或邮箱）
2. 构造消息内容
3. 使用 openclaw-wechat 渠道发送

### 场景 2: 文件分享
用户请求："把这个报告发给团队"

响应思路：
1. 确认文件路径或 URL
2. 识别团队成员列表
3. 通过企业微信发送带附件的消息

### 场景 3: 定时提醒
用户请求："每天早上 9 点提醒我查看待办事项"

响应思路：
1. 建议使用系统的定时任务（cron/scheduled task）
2. 配置定时调用企业微信 API
3. 发送提醒消息

## 消息格式

### 纯文本消息
```json
{
  "email": "user@example.com",
  "text": "这是一条文本消息"
}
```

### 带附件消息
```json
{
  "email": "user@example.com",
  "text": "请查收附件",
  "mediaUrl": "https://example.com/file.pdf"
}
```

### 同步响应（等待回复）
```json
{
  "email": "user@example.com",
  "text": "请问你现在有空吗？",
  "sync": true
}
```

## 最佳实践

1. **身份识别**: 始终确认收件人的正确标识符（企业微信账号/邮箱）
2. **消息内容**: 保持消息简洁、清晰、专业
3. **错误处理**: 如果发送失败，提供明确的错误信息和建议
4. **隐私保护**: 不要在消息中包含敏感信息（密码、密钥等）
5. **批量发送**: 如果需要发送给多人，逐个调用 API（避免群发滥用）

## 故障排查

### 消息发送失败
- 检查 `corpid`、`corpsecret` 是否正确
- 验证收件人账号是否存在
- 确认 Gateway 正在运行（`openclaw channels status`）

### 收不到回调
- 确认 `token` 和 `encodingAESKey` 配置正确
- 检查企业微信应用配置的回调 URL
- 验证网络防火墙设置

## 相关命令

```bash
# 查看渠道状态
openclaw channels status

# 测试发送消息
curl -X POST http://localhost:18789/openclaw-wechat/message \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "text": "测试消息"}'

# 查看配置
openclaw config get channels.openclaw-wechat
```

## 限制和注意事项

- 企业微信 API 有频率限制，避免短时间内大量请求
- 消息内容长度限制：文本消息最多 2048 字节
- 附件大小限制：根据企业微信配置而定
- 必须是企业内部成员才能接收消息

## 进阶功能

如果需要更高级的功能，可以：
1. 使用企业微信官方 SDK
2. 实现应用内免登录
3. 集成企业微信审批流程
4. 使用企业微信机器人 webhook
