# 最终安全评估报告

- **项目**：cf-ai-gw（Cloudflare Workers AI → OpenAI/Anthropic 兼容 API 网关）
- **评估时间**：2026-08-31 20:14
- **评估方法**：红队全量扫描 + 蓝队逐条复核
- **扫描范围**：src/index.js（模式 A，5637 行）、_worker.js（模式 B，6364 行）
- **最近 commit**：3fab21a、8203060、bcaad00
- **缺陷总数**：12 条（P2 ×3，P3 ×9，P0/P1 ×0）
- **执行说明**：security-red-team / security-blue-team subagent 类型在当前环境无法正常工作（多次启动秒退无输出），红蓝两阶段均由 team-leader 亲自执行。每条缺陷已交叉验证代码位置与可利用性，**无误报**。

---

## 一、需修复的缺陷（按优先级排序）

### 🔴 P2-1 音频转写 Content-Length 绕过 + 内存放大 OOM
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:1843-1846`、`src/index.js:1869` |
| **类型** | 资源耗尽 / 拒绝服务 |
| **风险** | P2 |
| **攻击向量** | ① chunked transfer-encoding 时 Content-Length 头缺失，`parseInt('0')`=0 绕过 100MB 检查；② `[...audioUint8]` 将 100MB Uint8Array 展开为 ~1 亿元素 JS 数组，内存放大 8 倍+，必然 OOM |
| **影响** | Worker 实例 OOM 崩溃，影响所有并发请求。checkProxyAuth 无 key 时开放，攻击门槛低 |
| **证据** | `const contentLength = parseInt(request.headers.get('Content-Length') \|\| '0', 10);`（chunked 时=0）；`const whisperInput = { audio: [...audioUint8] };`（1 亿元素数组） |
| **修复** | ① 用流式读取+累计字节数检查，不依赖 Content-Length 头；② CF whisper 实际接受 `audio: string`（binary/base64），改用 base64 或直接传 Uint8Array，避免数组展开；③ 降低上限到 25MB |

### 🔴 P2-2 流式 Binding 归一化 finish_reason 缺失（3fab21a 回归）
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:1492`（anthropicStreamTransform）、`src/index.js:2113`（passthroughStream） |
| **类型** | 逻辑缺陷（最近修复引入） |
| **风险** | P2 |
| **攻击向量** | CF 流式最后一个 chunk 可能是 `{usage: {...}}`（无 response、无 choices），当前条件 `!chunk.choices && chunk.response !== undefined` 不转换此尾块，finish_reason 缺失 |
| **影响** | `ensureFinishReason` 会补齐 `finish_reason: 'stop'`，但上游真实 finish_reason（如 'length'、'tool_calls'）被覆盖，客户端可能误判截断原因 |
| **修复** | 额外处理含 usage 但无 choices/response 的尾块：构造 `{choices: [{delta: {}, finish_reason: chunk.finish_reason \|\| 'stop'}], usage: chunk.usage}` |

### 🔴 P2-3 非流式 normalizeBindingResult 兜底返回非 OpenAI 格式（8203060 回归）
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:774-775` |
| **类型** | 逻辑缺陷（最近修复的兜底路径） |
| **风险** | P2 |
| **攻击向量** | 若 CF 返回既无 `choices` 也无 `response` 字符串的结果（如纯 `{usage}`），兜底原样返回，handleCompletions 直接 `jsonResponse(cfJson)` 返回非 OpenAI 格式，客户端解析失败 |
| **影响** | 特殊模型/版本返回非标准格式时非流式响应失败。CF 当前文本模型都返回 `{response}` 或 `{choices}`，触发概率低 |
| **修复** | 兜底构造空 choices 的 OpenAI 格式：`{choices: [{message: {role: 'assistant', content: typeof result === 'string' ? result : JSON.stringify(result)}, finish_reason: 'stop'}], ...}` |

### 🟡 P3-1 accountId 路径注入（模式 B）
| 项 | 内容 |
|---|---|
| **位置** | `_worker.js:79`（buildCFUrl）、`_worker.js:2842`、`_worker.js:2862` |
| **类型** | 路径注入 / SSRF（受限） |
| **风险** | P3 |
| **攻击向量** | 管理员配置恶意 accountId（含 `/`、`?`、`../`），直接拼进 URL。host 硬编码不可控（非经典 SSRF），但可改变路径结构。需管理员权限 |
| **修复** | `encodeURIComponent(account.accountId)` 或正则校验 `/^[a-f0-9]{32}$/` |

### 🟡 P3-2 CSRF token 非时序安全比较
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:2246`、`_worker.js:2757` |
| **类型** | 时序侧信道（理论） |
| **风险** | P3 |
| **说明** | `csrfCookie !== csrfHeader` 用 `!==` 字符串比较。token 是 64 字符 sha256，网络抖动下实际不可利用 |
| **修复** | 改用已有的 `timingSafeEqual(csrfCookie, csrfHeader)` |

### 🟡 P3-3 CSRF cookie 缺 HttpOnly
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:3507` |
| **类型** | Cookie 属性缺失 |
| **风险** | P3 |
| **说明** | 前端从 `<meta>` 读 csrf-token，不从 cookie 读，cookie 可加 HttpOnly。已有 SameSite=Strict+Secure |
| **修复** | cookie 字符串加 `HttpOnly;` |

### 🟡 P3-4 图片生成 width/height 无上限校验
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:1789-1790` |
| **类型** | 输入校验缺失 |
| **风险** | P3 |
| **说明** | 攻击者传 `size: "99999x99999"`，上游 CF 会拒绝但浪费推理配额 |
| **修复** | `Math.min(Math.max(parseInt(parts[0]) \|\| 1024, 64), 2048)` |

### 🟡 P3-5 模式 A /api/accounts/test 永远返回成功
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:2294-2303` |
| **类型** | 功能性缺陷 |
| **风险** | P3 |
| **说明** | 硬编码 `success: true`，"测试连接"按钮永远显示成功，用户可能误以为 Binding 已正确配置 |
| **修复** | 改为实际调用 `env.AI.run` 做轻量推理测试 |

### 🟡 P3-6 模式 A 前端保留账号管理 UI 但后端无 CRUD
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:5081`、`src/index.js:5253`、`src/index.js:5270` |
| **类型** | 前后端不匹配 |
| **风险** | P3 |
| **说明** | 前端有编辑/删除账号按钮调 POST/PUT/DELETE `/api/accounts`，后端只有 GET+test。点击会 404 |
| **修复** | 模式 A 前端隐藏账号管理区块，或后端返回"模式 A 不支持多账号"提示 |

### 🟡 P3-7 API key 明文回传前端
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:2307-2308` |
| **类型** | 敏感信息暴露 |
| **风险** | P3 |
| **说明** | GET /api/keys 返回完整 key 明文。已有 XSS 防护。已知接受项变体 |
| **修复** | 返回 `maskTokenKey(key)` 掩码，编辑时用 `includes('*')` 判断保留原 key |

### 🟡 P3-8 timingSafeEqual 长度提前返回
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:397-398` |
| **类型** | 时序侧信道（理论） |
| **风险** | P3 |
| **说明** | 比较值都是 sha256 十六进制（64 字符恒定），实际无泄露 |
| **修复** | 无需修改（长度恒定） |

### 🟡 P3-9 流式归一化 chunk.response 非字符串时 content 类型异常
| 项 | 内容 |
|---|---|
| **位置** | `src/index.js:1492`、`src/index.js:2113` |
| **类型** | 逻辑缺陷（边界） |
| **风险** | P3 |
| **说明** | CF 流式 response 总是字符串，触发概率极低 |
| **修复** | `content: typeof chunk.response === 'string' ? chunk.response : JSON.stringify(chunk.response)` |

---

## 二、确认安全的领域

| 领域 | 结论 |
|---|---|
| **CORS** | `/api/` 只允许同源，`/v1/` 用 `*`（API key 认证无 cookie，可接受）。无任意 origin 反射 ✅ |
| **XSS** | 管理面板所有 innerHTML 渲染均用 `escapeHtml` + `attrEscape` 转义。未发现未转义注入点 ✅ |
| **认证** | checkAdminAuth 用 timingSafeEqual 比较 sha256 哈希（恒时）；cookie 有 HttpOnly+Secure+SameSite=Strict ✅ |
| **CSRF** | 所有写操作校验 X-CSRF-Token + SameSite=Strict ✅（比较方式见 P3-2） |
| **SSRF** | 所有 fetch 硬编码 `api.cloudflare.com`，host 不可控 ✅（accountId 见 P3-1） |
| **注入** | 无 eval/Function/动态模板。SSE 用 JSON.parse+try/catch。GraphQL 参数化 ✅ |
| **日志脱敏** | console.error 打印 `e?.message`，未发现打印 token/password/key 明文 ✅ |
| **熔断器** | isolate 内存态，单线程事件循环无竞态 ✅ |
| **流式清理** | 所有 done/catch/cancel 分支均有 pingInterval 清理 ✅ |

---

## 三、已知且用户裁决接受的历史问题

- API Token/API Key 明文存 KV（README 已标注）
- 无 key 时 checkProxyAuth 开放（用户裁决维持）
- 限额拦截基于过期 GraphQL 缓存（P1-B）；failover 无熔断（P1-C）
- KV read-modify-write 丢失更新、流式 token 中断漏记、错误码一律 server_error、会话 token 静态无撤销（P2-1/2/3/5）
- 全站无限流/无登录爆破防护（P1-A，用户裁决跳过——CF 平台自带限流）

---

## 四、修复优先级建议

| 优先级 | 编号 | 建议 |
|---|---|---|
| **建议立即修** | P2-1 | 音频 OOM 影响可用性，checkProxyAuth 开放时攻击门槛低 |
| **建议尽快修** | P2-2, P2-3 | 最近修复引入的回归风险，影响流式/非流式响应正确性 |
| **择机修复** | P3-1~P3-4 | 安全加固类，低风险 |
| **可暂缓** | P3-5~P3-9 | 功能性缺陷或理论风险，不影响安全 |

---

## 五、等级分布

| 等级 | 数量 | 编号 |
|------|------|------|
| P0 严重 | 0 | — |
| P1 高 | 0 | — |
| P2 中 | 3 | P2-1, P2-2, P2-3 |
| P3 低 | 9 | P3-1 ~ P3-9 |
| **合计** | **12** | |