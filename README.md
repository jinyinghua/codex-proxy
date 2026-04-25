# codex-proxy

一个部署到 Vercel 的极简转发器，给 NewAPI 的 Codex/Responses 渠道用。

作用：
- 接收 `/v1/responses`
- 当 `model` 形如 `gpt-draw-1024x1024` 时：
  - 自动改写为真实模型 `DRAW_REAL_MODEL`
  - 自动注入 `tools: [{"type":"image_generation"}]`
- 原样透传 `Authorization` 到上游
- 再把请求转发到 `UPSTREAM_BASE_URL/v1/responses`

## 路由

- `POST /api/v1/responses`
- `GET /api/v1/models`

在 NewAPI 里把 base_url 填成：

```text
https://你的项目.vercel.app/api
```

这样它访问 `/v1/responses` 时就会命中这个函数。

## 环境变量

必填：

```text
UPSTREAM_BASE_URL=https://你的Codex上游地址
DRAW_REAL_MODEL=真实模型名
```

可选：

```text
IMAGE_TOOL_FORMAT=plain
FORCE_TOOL_CHOICE=
PUT_SIZE_IN_BODY=false
```

### 可选项说明

- `IMAGE_TOOL_FORMAT=plain`
  - 注入 `{ "type": "image_generation" }`
- `IMAGE_TOOL_FORMAT=with_size`
  - 注入 `{ "type": "image_generation", "size": "1024x1024" }`
- `FORCE_TOOL_CHOICE=required`
  - 追加 `tool_choice: "required"`
- `FORCE_TOOL_CHOICE=image_generation`
  - 追加 `tool_choice: { "type": "image_generation" }`
- `PUT_SIZE_IN_BODY=true`
  - 额外写入顶层 `size`

## 模型别名

当前支持：

- `gpt-draw-1024x1024`
- `gpt-draw-1024x1536`
- `gpt-draw-1536x1024`

实际上规则是通配：

```text
gpt-draw-宽x高
```

## 说明

这个代理不保存上游 key。

上游 key 仍由 NewAPI 在请求时放进：

```http
Authorization: Bearer ...
```

本项目只负责：
- 读取请求体
- 改写模型和 tools
- 转发到上游

## 本地测试

```bash
curl http://localhost:3000/api/v1/responses \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test-key' \
  -d '{
    "model": "gpt-draw-1024x1024",
    "input": "画一只白色小猫，动漫风"
  }'
```
