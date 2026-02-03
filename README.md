# openclaw-wechat-plugin

企业微信（WeCom）集成插件，支持接收和发送企业微信消息。

## 安装

```bash
# 示例：
# openclaw plugins install <你的发布包名>
# 或直接从源码目录加载（取决于你的 OpenClaw 插件加载方式）
```

## 快速开始

### 1. 启用插件

```bash
openclaw plugins enable simple-wecom
```

### 2. 配置企业微信

```bash
# 企业微信应用配置（必需）
openclaw config set channels.simple-wecom.corpid "ww1234567890abcdef"
openclaw config set channels.simple-wecom.corpsecret "your-corp-secret"
openclaw config set channels.simple-wecom.token "your-token"
openclaw config set channels.simple-wecom.encodingAESKey "your-aes-key"
openclaw config set channels.simple-wecom.enabled true
```

### 3. 配置 Gateway

```bash
openclaw config set gateway.mode "local"
openclaw config set gateway.bind "0.0.0.0"
openclaw config set gateway.port 18789
```

### 4. 重启 Gateway

```bash
openclaw gateway restart
```

### 5. 验证

```bash
openclaw channels status
```

## 配置说明

### 如何获取企业微信配置参数

1. 登录 [企业微信管理后台](https://work.weixin.qq.com/)
2. 进入"应用管理" → 选择或创建应用
3. 在应用详情页获取：
   - `AgentId`：应用ID
   - `Secret`：点击"查看Secret"获取
4. 在"接收消息"设置中获取：
   - `Token`：点击"随机获取"
   - `EncodingAESKey`：点击"随机获取"
5. 在"我的企业"中查看 `企业ID (CorpID)`

### 配置回调 URL

在企业微信管理后台，配置应用回调 URL：

```
http://your-gateway-host:18789/simple-wecom/message
```

## 功能特性

- ✅ 企业微信消息接收与解密
- ✅ 多种消息类型支持（文本、图片、语音、视频、位置、链接）
- ✅ 企业微信 API 消息发送
- ✅ 文件附件支持
- ✅ 同步/异步模式
- ✅ 多账号管理

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
