# Dola账号池

Dola账号池是一款基于 Electron 的桌面服务端，用于管理多个相互隔离的Dola登录环境，并通过加密 TLS/TCP 接口向独立用户客户端提供视频生成能力。

当前版本：`0.3.1`

## 主要功能

- 多账号隔离：每个账号使用固定的 Electron `persist:` partition，Cookie、LocalStorage、缓存和登录状态互不混用。
- 登录持久化：关闭软件后保留各账号登录状态，下次启动可继续使用。
- 持久额度管理：每个账号默认 4 点，固定使用 Seedance 2.5，每次生成消耗 2 点；剩余和已用额度写入 SQLite，重启后继续保留。
- 账号池调度：自动选择已登录、空闲且额度充足的账号执行请求。
- 后台视频生成：支持文本提示词和参考图片，跟踪等待、执行、成功和失败状态。
- 30 秒模式：Seedance 2.5 请求在发送前强制校验“视频生成、2.5、30s、扩展开启”，校验失败时不会提交。
- 内嵌 API 调试：可在软件内填写请求、提交真实本地 API、自动轮询结果，并按需显示Dola执行窗口。
- 严格结果输出：只有取得经过验证的真实 MP4 地址或本地 MP4 文件后，任务才会返回 `success`。
- 可选去水印：可配置第三方解析接口；只在取得并验证 MP4 后返回 `success`，解析失败或未取得 MP4 时返回 `failed`。
- 用户端 TCP 服务：默认监听 `0.0.0.0:17889`，注册、登录、积分、生成、轮询和 MP4 下载均通过 TLS/TCP 完成。
- 内部 HTTP 服务：仅监听服务端本机 `127.0.0.1:17888`，供管理界面和 TCP 网关桥接，不需要暴露到公网。
- 可观测界面：提供账号概览、剩余额度、Seedance 2.5 预计产能、搜索筛选和接口日志详情。
- 行动日志：逐步记录账号、任务、分享地址、去水印和错误信息，默认保留 3 天并自动清理。
- 结果恢复与诊断：支持从账号最近对话恢复已生成视频，日志显示分享复制、去水印重试和耗时信息。
- 跨平台安装包：提供 macOS Apple Silicon DMG 和 Windows x64 EXE。

## 下载与安装

请从 [Releases](../../releases/latest) 下载当前版本：

- Windows 服务端：下载 `Dola账号池接口服务-0.3.1-win-x64.exe`，或使用免安装便携版。
- Windows 用户端：下载 `Dola API客户端-0.3.0-win-x64.exe`。

macOS 应用已进行完整 ad-hoc 签名，避免因 Electron 临时签名不完整而显示“应用已损坏”。当前安装包尚未使用 Apple Developer ID 公证或 Windows 商业代码签名，Gatekeeper 或 SmartScreen 首次运行时仍可能显示来源提示。请核对发布页中的 SHA-256；macOS 首次尝试打开后，可进入“系统设置 > 隐私与安全性”，在安全性区域选择“仍要打开”。

## 快速开始

1. 安装并启动应用。
2. 点击“添加账号”，在打开的独立Dola窗口中完成登录。
3. 返回账号池执行检测，确认账号显示为“已登录”和“空闲”。
4. 在“配置管理”中启用用户端 TLS/TCP 服务并确认端口（默认 `17889`）。
5. 在 Windows 防火墙和路由器/云安全组放行该 TCP 端口，把 `服务器IP:17889` 发给用户。
6. 用户在独立客户端中输入该地址，注册或登录后即可提交生成任务。

## 用户端 TCP 接口

用户客户端不连接公网 HTTP/HTTPS 地址，直接连接 `服务器IP:17889`。服务端首次运行会生成 TLS 证书，客户端首次连接保存证书 SHA-256 指纹，后续指纹变化时拒绝连接。

如需经过网关转发，请使用四层 TCP 转发；普通 HTTP 反向代理不适用。协议和 action 说明见 [docs/TCP_API.md](docs/TCP_API.md)。

## 服务端内部 HTTP API

此接口仅绑定本机回环地址，主要用于服务端管理界面、兼容旧工作流和 TCP 网关内部桥接，不应直接暴露到公网。

默认地址：`http://127.0.0.1:17888`

```bash
curl -X POST http://127.0.0.1:17888/api/generate \
  -H "Authorization: Bearer local-dola-key" \
  -F "model=seedance_2_5" \
  -F "prompt=生成一段 30 秒科普视频" \
  -F "referenceImage=@/path/to/reference-1.png" \
  -F "referenceImage=@/path/to/reference-2.png" \
  -F "callbackUrl=http://127.0.0.1:3000/dola/callback"
```

提交成功会先返回 `accepted`，可通过下面的接口查询：

```bash
curl http://127.0.0.1:17888/api/requests/dola-xxxxxxxxxxxxxxxx \
  -H "Authorization: Bearer local-dola-key"
```

成功结果只包含最终可用的视频字段：

```json
{
  "requestId": "dola-xxxxxxxxxxxxxxxx",
  "status": "success",
  "message": "视频生成完成，去水印 MP4 地址已验证（耗时 X 秒，第 N 次解析）",
  "model": "seedance_2_5",
  "cleanVideoUrl": "https://example.com/video.mp4",
  "outputVideoPath": null
}
```

内部接口说明见 [docs/API.md](docs/API.md)。

第一次使用、连接无限画布和排错请先阅读 [新手使用手册](docs/USER_GUIDE.md)。

## 数据位置

运行数据不会提交到仓库：

- macOS：`~/Library/Application Support/dola-account-manager/`
- Windows：`%APPDATA%/dola-account-manager/`

SQLite 数据库、账号 partition、Cookie、缓存、上传参考图和登录状态均保存在对应系统用户目录。

## 本地开发

环境要求：Node.js 20 或更高版本。

```bash
npm ci
npm run dev
```

常用命令：

```bash
npm run typecheck  # TypeScript 检查
npm run build      # 生产构建
npm run dist       # macOS 安装包
npm run dist:win   # Windows x64 安装包
```

## 技术栈

- Electron
- Vue 3
- TypeScript
- SQLite / better-sqlite3
- Vite
- electron-builder

## 使用边界

本项目不提供自动注册、验证码处理、账号限制绕过或平台风控规避。请遵守Dola及相关第三方服务的使用规则，仅在本人拥有权限的账号和内容上使用。

本项目是非官方本地工具，与Dola或字节跳动不存在隶属、授权或合作关系。

## 更新记录

版本变化见 [CHANGELOG.md](CHANGELOG.md)。
