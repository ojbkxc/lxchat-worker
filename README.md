# cf-ai-gw

将 Cloudflare Workers AI 转成 OpenAI / Anthropic 兼容 API 的网关，自带可视化管理面板。支持多账号负载均衡、故障自动切换、真实 Neurons 用量看板。

## 部署模式

| 模式 | 入口文件 | 调用方式 | 账号模式 | 规避检查 |
|------|---------|---------|---------|---------|
| **模式 A：Worker + AI Binding** | `src/index.js` | `env.AI.run()` 内部 RPC | 单账号 | ⭐⭐⭐ 最佳 |
| **模式 B：Worker + REST API** | `_worker.js` | `fetch()` 公网 REST | 多账号 failover | ⭐⭐ 良好 |

> 两模式共用同一 KV 时数据互通：API Key、模型映射、限额配置、账号列表、用量看板完全一致。

## 快速部署（推荐：模式 A — Worker + AI Binding）

> 推荐使用 **模式 A（Worker + AI Binding，入口 `src/index.js`）**：单账号、内部 RPC 调用 Workers AI，无需 API Token，风控规避最佳。
> 模式 B（`_worker.js`，多账号 failover）和 Pages 高级模式（同模式 B 代码）作为备选，见文末「备选部署模式」。

### 1. 创建 Worker 项目

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 点 **创建应用程序** → 切到 **Worker** 标签 → **Import a repository** → **开始使用**
3. 授权 GitHub，选择 `cf-ai-gw` 仓库，分支 `main`
4. 保存并部署

或使用 wrangler 直连部署：

```bash
npx wrangler deploy
```

### 2. 配置绑定和环境变量

部署完成后，进入 Worker 的 **Settings**：

| 配置项 | 位置 | 说明 |
|--------|------|------|
| KV 绑定 | Settings → **Bindings** | 添加 KV 命名空间，Variable name 填 `KV` |
| AI 绑定 | Settings → **Bindings** | 添加 Workers AI Binding，Variable name 填 `AI`（模式 A 必需） |
| `ADMIN_PASSWORD` | Settings → **Variables & Secrets** | 管理面板登录密码（必填） |

> **注意**：`wrangler.toml` 中已声明 KV/AI 绑定与 `[vars] ADMIN_PASSWORD`，`npx wrangler deploy` 会按 toml 部署；Dashboard 中手工添加的绑定/变量（如自定义域 routes）在 deploy 时可能被覆盖，diff 警告需仔细确认。

### 3. 配置 Cloudflare 账号（模式 B）

1. 访问 Worker 地址，打开 `/admin` 管理面板
2. 输入 `ADMIN_PASSWORD` 登录
3. 在「账号管理」中添加 Cloudflare 账号：
   - **Account ID**：Cloudflare 账号 ID
   - **API Token**：有 Workers AI + Account Analytics 权限的 API Token
   - **名称**：任意，用于区分多个账号

> 支持添加多个账号，自动负载均衡和故障切换。账号信息以明文存储在 KV 中。
> 模式 A 无需配置账号（AI Binding 即账号），但看板的真实 Neurons 数据同样来自账号列表的 GraphQL 查询——模式 A 的管理面板**只读**展示账号（无法增删），需先在模式 B 面板添加账号（两者共用同一 KV），或模式 A 面板配置为空时看板显示空数据。

### 4. 创建 API Key

在管理面板的「API Key」中创建 Key，客户端调用时使用：

```bash
curl https://cf-ai-gw.YOUR_SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model": "glm-4.7-flash", "messages": [{"role": "user", "content": "你好"}]}'
```

## 数据看板

管理面板「数据看板」展示真实神经元消耗（与 Cloudflare 计费一致）：

- **今日消耗 / 请求次数**：CF GraphQL Analytics API 查询的 `totalNeurons`（真实计费数据，模式 A/B 的消耗均计入）
- **今日模型消耗占比**：按 CF 真实 modelId 维度的 Neurons 分布
- **近 7 日消耗走势**：逐日 Neurons 消耗与请求数
- **本月用量 / 月度请求**：月初起累计
- **今日 Token 统计**：网关本地 token 统计（input/output/推理/缓存读，与 Neurons 口径不同）

> 用量数据来自 GraphQL（有数分钟延迟），单次刷新至多更新 3 个账号（防风控），账号按最后更新时间轮转刷新。
> 跨模式部署（A + B 共用 KV）时，两模式看板数值完全一致。

## 切换模式

编辑 `wrangler.toml` 修改 `main` 字段后推送即可（默认为模式 A）：

```toml
# 模式 A（默认，推荐）：Worker + AI Binding（需在 Dashboard 添加 AI Binding）
main = "src/index.js"

# 模式 B：Worker + REST API（多账号 failover）
main = "_worker.js"
```

## 模式对比

| 维度 | 模式 A（Binding） | 模式 B（REST） |
|------|-------------------|----------------|
| 调用路径 | Worker → AI Binding RPC → Workers AI | Worker → 公网 HTTPS → api.cloudflare.com |
| 认证方式 | Worker 账号自动认证 | API Token 显式认证 |
| HTTP 开销 | 无 TLS / 无网关跳转 | 每次请求经 Cloudflare 网关 |
| 账号管理 | 单账号（绑定即账号） | 多账号 failover（KV 存 Token） |
| 风控规避 | ⭐⭐⭐ 内部 RPC，不触发网关检测 | ⭐⭐ 默认 Worker UA + 串行请求 + 退避重试 |
| 用量查询 | GraphQL（共用模式B账号配置） | GraphQL 拉取 Neurons |
| 模型列表 | 仅 `@cf/` 开头，按 token 降序 | 全部映射模型，按 token 降序 |
| 安全增强 | 熔断器 + 断供闩 + 过大闸 | 多账号 failover + 可恢复流 |

## 备选部署模式

### 模式 B：Worker + REST API（多账号 failover）

入口文件改为 `_worker.js`，Dashboard 无需 AI Binding，在管理面板「账号管理」添加多个 Cloudflare 账号（Account ID + API Token），自动负载均衡与故障切换。适合需要多账号分流或不想绑定 AI Binding 的场景。

```toml
# wrangler.toml
main = "_worker.js"
```

### Pages 高级模式（Advanced Mode）

将 `_worker.js` 放在 Pages 项目部署目录根下，Pages 会把它作为 Worker 执行，行为等同于模式 B（不绑 AI Binding、走 REST API）。适合希望用 Pages 托管、或通过 `wrangler pages deploy` 直接上传构建产物的场景。

```bash
# 创建 Pages 项目
npx wrangler pages project create cf-ai-gw --production-branch main

# 部署：把 _worker.js 放进部署目录根下
mkdir -p dist-pages && cp _worker.js dist-pages/
npx wrangler pages deploy dist-pages --project-name cf-ai-gw --branch main
```

> **注意**：Pages 高级模式同样需要在 Pages 项目 Settings → Bindings 里绑定 KV（Variable name 填 `KV`）；Pages 不支持 Workers AI Binding，所以只能走模式 B 的 REST API 路径。

## API 端点

### OpenAI 兼容

| 端点 | 方法 |
|------|------|
| `/v1/chat/completions` | POST |
| `/v1/completions` | POST |
| `/v1/responses` | POST |
| `/v1/embeddings` | POST |
| `/v1/models` | GET |
| `/v1/models/{model}` | GET |
| `/v1/images/generations` | POST |
| `/v1/audio/transcriptions` | POST |
| `/v1/audio/translations` | POST |
| `/v1/audio/speech` | POST |

> `/v1/responses` 支持 OpenAI Responses 协议（新版 codex-cli 直连），含流式 SSE 事件状态机与 tool_calls 往返。

### Anthropic 兼容

| 端点 | 方法 |
|------|------|
| `/v1/messages` | POST |
| `/v1/messages/count_tokens` | POST |

### 管理面板

| 端点 | 说明 |
|------|------|
| `/admin` | 可视化管理面板 |
| `/api/auth/login` | 登录 |
| `/api/auth/logout` | 退出登录 |
| `/api/tokens/today` | 今日 Token 统计（本地 token 口径） |
| `/api/usage/summary` | 用量汇总（真实 Neurons） |
| `/api/accounts/usage` | 账号用量明细（真实 Neurons） |
| `/api/keys` | API Key 管理 |
| `/api/settings` | 模型映射配置 |
| `/api/limits` | 限额配置 |
| `/api/accounts` | 账号管理（模式 A 只读） |
| `/api/accounts/test` | 账号连通性测试 |
| `/api/models/search` | 搜索 CF 可用模型 |

## 可选环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DAILY_LIMIT` | 10000 | 每日限额 |
| `MONTHLY_LIMIT` | 100000 | 每月限额 |
| `USAGE_THRESHOLD` | 0 | 限额拦截阈值（0=仅统计不拦截） |
| `STRICT_MODEL_MATCH` | 关 | 设为 `true` 时无效模型名返回 404（默认回退兜底模型） |
| `OVERSIZE_TOKENS` | 按模型 | 请求过大 token 闸（仅模式 A）。闸值优先级：显式配置值 > 模型自身 token 上限（含 KV 自定义）> 默认 200000；设 `0` 关闭 |
| `CB_WINDOW_MS` | 10000 | 熔断器窗口（毫秒，仅模式 A） |
| `CB_FAIL_THRESHOLD` | 8 | 熔断器失败阈值（仅模式 A） |
| `CB_COOLDOWN_MS` | 4000 | 熔断器冷却时间（毫秒，仅模式 A） |
| `MODEL_DOWN_FAILS` | 3 | 模型断供判死连续失败数（仅模式 A） |
| `MODEL_DOWN_AFTER_MS` | 60000 | 模型断供判死持续时间（毫秒，仅模式 A） |

## 内置模型

管理面板中可自定义模型映射，内置默认映射如下。`/v1/models` 端点按 token 上限从大到小排序返回。

### 文本生成模型

| 模型名 | Cloudflare 模型 | Tokens |
|--------|----------------|--------|
| `deepseek-v4-flash-0731` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | 1,310,720 |
| `glm-5.3` | `@cf/zai-org/glm-5.3` | 1,310,720 |
| `glm-5.3-flash` | `@cf/zai-org/glm-5.3-flash` | 1,310,720 |
| `deepseek-v4-pro-0813` | `@cf/deepseek-ai/deepseek-v4-pro-0813` | 1,048,576 |
| `glm-5.2` | `@cf/zai-org/glm-5.2` | 262,144 |
| `kimi-k2.7-code` | `@cf/moonshotai/kimi-k2.7-code` | 262,144 |
| `kimi-k2.6` | `@cf/moonshotai/kimi-k2.6` | 262,144 |
| `nemotron-3-120b-a12b` | `@cf/nvidia/nemotron-3-120b-a12b` | 256,000 |
| `glm-4.7-flash` | `@cf/zai-org/glm-4.7-flash` | 131,072 |
| `gemma-4-26b-a4b-it` | `@cf/google/gemma-4-26b-a4b-it` | 131,072 |
| `gemma-sea-lion-v4-27b-it` | `@cf/aisingapore/gemma-sea-lion-v4-27b-it` | 131,072 |
| `llama-3.1-8b-instruct-fast` | `@cf/meta/llama-3.1-8b-instruct-fast` | 131,072 |
| `llama-3.2-1b-instruct` | `@cf/meta/llama-3.2-1b-instruct` | 131,072 |
| `llama-3.2-11b-vision-instruct` | `@cf/meta/llama-3.2-11b-vision-instruct` | 131,072 |
| `llama-4-scout-17b-16e-instruct` | `@cf/meta/llama-4-scout-17b-16e-instruct` | 131,000 |
| `qwen3.8-27b` | `@cf/qwen/qwen3.8-27b` | 131,072 |
| `mistral-small-3.1-24b-instruct` | `@cf/mistral/mistral-small-3.1-24b-instruct` | 131,072 |
| `granite-4.0-h-micro` | `@cf/ibm/granite-4.0-h-micro` | 131,072 |
| `qwen3-30b-a3b-fp8` | `@cf/qwen/qwen3-30b-a3b-fp8` | 32,768 |
| `qwq-32b` | `@cf/qwen/qwq-32b` | 32,768 |
| `llama-3.3-70b-instruct-fp8-fast` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24,000 |
| `gpt-oss-20b` | `@cf/openai/gpt-oss-20b` | — |
| `gpt-oss-120b` | `@cf/openai/gpt-oss-120b` | — |
| `llama-3.2-3b` | `@cf/meta/llama-3.2-3b-instruct` | — |

### 向量嵌入模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `embeddinggemma-300m` | `@cf/google/embeddinggemma-300m` |
| `qwen3-embedding-0.6b` | `@cf/qwen/qwen3-embedding-0.6b` |
| `bge-m3` | `@cf/baai/bge-m3` |
| `bge-large-en` | `@cf/baai/bge-large-en-v1.5` |
| `bge-base-en-v1.5` | `@cf/baai/bge-base-en-v1.5` |
| `bge-reranker-base` | `@cf/baai/bge-reranker-base` |

### 多模态模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `llava-1.5-7b` | `@cf/llava-hf/llava-1.5-7b-hf` |
| `moondream3.1-9B-A2B` | `@cf/moondream/moondream3.1-9B-A2B` |
| `flux-1-schnell` | `@cf/black-forest-labs/flux-1-schnell` |
| `flux` | `@cf/black-forest-labs/flux-1-schnell`（别名） |
| `sdxl` | `@cf/stabilityai/stable-diffusion-xl-base-1.0` |

### 语音模型

| 模型名 | Cloudflare 模型 |
|--------|----------------|
| `whisper` | `@cf/openai/whisper` |
| `whisper-tiny-en` | `@cf/openai/whisper-tiny-en` |
| `whisper-large-v3-turbo` | `@cf/openai/whisper-large-v3-turbo` |
| `nova-3` | `@cf/deepgram/nova-3` |
| `tts` | `@cf/deepgram/aura-2-en`（TTS） |
| `aura-2-en` | `@cf/deepgram/aura-2-en` |

> `owned_by` 字段由 `getModelOwnedBy` 从 `@cf/` 路径自动提取（如 `@cf/meta/xxx` → `meta`），无需维护前缀表。完整列表见代码中的 `DEFAULT_MODEL_MAP`。

## 发版说明

发布新版本时同时发 **GitHub Release（`/releases`）和 tag（`/tags`）**：

```bash
# 1. 在目标提交上打附注 tag 并推送
git tag -a vX.Y.Z -m "版本说明" <commit> && git push origin vX.Y.Z

# 2. 通过 API 创建 Release（Release 会自动引用已推送的 tag）
#    本机无 gh CLI 时可用 git credential 里的 token 调 GitHub API
```

> 只推 tag 不会出现在 `/releases` 页面——Release 是独立对象，必须单独创建（会引用 tag 并挂发布说明）。
