# 本地 API

## 基础信息

- 默认地址：`http://127.0.0.1:17888`
- 当前接口版本：`0.2.0`
- 认证：`Authorization: Bearer <token>`
- `/health`、`/api/auth/register`、`/api/auth/login` 无需登录；其余接口均需要 Bearer Token。
- 首次运行会生成随机管理端 API Key。该 Key 可绕过用户积分，仅限服务端保管，不要发给普通用户。

## 用户注册与登录

```http
POST /api/auth/register
Content-Type: application/json

{"username":"demo_user","password":"至少8位密码"}
```

注册用户初始为 0 积分。登录与注册都会返回 `accessToken`，用户客户端后续将它作为 Bearer Token 使用。

```http
POST /api/auth/login
Content-Type: application/json

{"username":"demo_user","password":"至少8位密码"}
```

用户可查询自己的资料、积分流水和最近任务：

```http
GET /api/me
GET /api/me/credits
GET /api/me/requests?limit=20
Authorization: Bearer <user-access-token>
```

退出登录并使当前 Token 立即失效：

```http
POST /api/auth/logout
Authorization: Bearer <user-access-token>
```

Seedance 2.5 每次固定消耗 2 用户积分。任务在真正提交给 Dola 前失败时自动退款；已经提交到 Dola 的任务不会因取消或后处理失败而退款。

## 管理端发放积分

以下接口需要“配置管理”中的管理端 API Key，或管理员用户的登录 Token：

```http
GET /api/admin/users
GET /api/admin/credits
Authorization: Bearer <admin-token>
```

```http
POST /api/admin/credits/grant
Authorization: Bearer <admin-token>
Content-Type: application/json

{"userId":1,"amount":10,"note":"充值 10 积分"}
```

`amount` 为正数时发放，为负数时扣减；扣减后的余额不能小于 0。服务端软件中的“用户积分”页也可完成相同操作。

## 健康检查

```http
GET /health
```

## 查询账号

```http
GET /api/accounts
Authorization: Bearer <api-key>
```

## 提交视频生成

```http
POST /api/generate
Authorization: Bearer <api-key>
Content-Type: multipart/form-data
```

字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 视频提示词 |
| `model` | 否 | 仅支持 `seedance_2_5`；不传时自动选择 |
| `referenceImage` | 否 | 上传的参考图片文件；可重复传入，合计最多 10 张 |
| `referenceImagePath` | 否 | 本机参考图片绝对路径 |
| `referenceImageUrl` | 否 | 可下载的参考图片 URL |
| `referenceImagePaths` | 否 | JSON 请求中的本机图片路径数组，最多 10 张 |
| `referenceImageUrls` | 否 | JSON 请求中的图片 URL 数组，最多 10 张 |
| `callbackUrl` | 否 | 状态变化时接收 JSON 的回调地址 |
| `source` | 否 | 请求来源名称 |

生成请求固定执行最终 MP4 结果验证。去水印失败、平台不支持或没有取得可播放 MP4 时，任务状态为 `failed`。

执行器固定选择 Seedance 2.5，并在真正发送前确认Dola页面处于视频生成模式、模型为 Seedance 2.5、工具栏显示 `30s` 且内置扩展已开启。任一条件不满足会直接返回失败，不会误发成其他模型或较短时长。软件内的“API 调试”页支持一次选择最多 10 张参考图、提交同一个接口并自动轮询最终结果；勾选“显示 Dola 浏览器执行窗口”可现场观察执行过程。

## 查询任务状态

```http
GET /api/requests/:requestId
Authorization: Bearer <api-key>
```

状态：

| 状态 | 说明 |
| --- | --- |
| `accepted` | 已接收并进入队列 |
| `running` | 正在操作Dola或等待生成 |
| `success` | 已取得经过验证的 MP4 地址或本地 MP4 文件 |
| `failed` | 提交、生成、解析或 MP4 验证失败 |
| `stopped` | 任务已停止 |

## 恢复历史结果

```http
POST /api/requests/:requestId/retry-result
Authorization: Bearer <api-key>
```

该接口只重新查找并解析历史生成结果，不会再次提交视频生成，也不会重复扣除额度。

## 单独解析视频结果

```http
POST /api/watermark/parse
Authorization: Bearer <api-key>
Content-Type: application/json

{
  "url": "<supported-source-url>"
}
```

成功时返回经过验证的 `cleanVideoUrl`；失败时返回 HTTP 422 和 `status: "failed"`。

去水印服务存在短暂的资源准备延迟。程序会先验证返回地址确实是可播放 MP4，未就绪时使用短间隔重试；重试状态会按任务顺序异步通知回调，不会阻塞视频结果解析。

## 成功语义

外部接口不会把Dola分享页、聊天页或 thread 页面地址当作视频结果。只有满足以下任一条件才返回 `status: "success"`：

- `cleanVideoUrl` 是经过验证、可访问的 MP4 视频地址。
- `outputVideoPath` 是已经保存成功的本地 `.mp4` 文件路径。
