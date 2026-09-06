/**
 * cf-ai-gw (Binding Edition)
 * 使用 Workers AI Binding 的单账号版本，用 env.AI.run() 替代 REST API 调用。
 * 无多账号 failover，无账号管理，直接使用 Worker 绑定的 AI 服务。
 */

// 用量限额配置（环境变量覆盖，未设置则用默认值）
const DEFAULT_DAILY_LIMIT = 10000;
const DEFAULT_MONTHLY_LIMIT = 100000;
const DEFAULT_USAGE_THRESHOLD = 0; // 0 表示关闭限额拦截（仅统计不拦截）

// 缓存与刷新常量
const MONTHLY_USAGE_TTL_SEC = 38 * 24 * 60 * 60;
const MODEL_CREATED_TS = 1686935000;

function safeJSONParse(raw, defaultVal) {
	if (!raw) return defaultVal;
	try { return JSON.parse(raw); } catch { return defaultVal; }
}

function getTodayStr() {
	return new Date().toISOString().split('T')[0];
}

const TOKEN_KV_TTL_SEC = 86400 * 8;    // KV 键保留 8 天（看板 7 日走势需要历史数据）
const USAGE_REFRESH_LIMIT = 3;         // 单次刷新的账号数上限（防 CF 风控，与模式 B 一致）

// 获取 token 统计 KV 键名
function getTokenDailyKey() {
	return `tokens_daily_${getTodayStr()}`;
}

// 获取月度 token 统计 KV 键名
function getTokenMonthlyKey() {
	const d = new Date();
	return `tokens_monthly_${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 累加 token 直接写入 KV（无内存缓冲，避免冷启动丢失）
async function accumulateTokens(env, ctx, { input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, durationSec = 0, model = null }) {
	ctx.waitUntil((async () => {
		try {
			// 今日统计
			const dailyKey = getTokenDailyKey();
			const raw = await env.KV.get(dailyKey);
			const cur = raw ? JSON.parse(raw) : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 0, tokPerSecSum: 0, tokPerSecCount: 0, models: {} };
			cur.input += input;
			cur.output += output;
			cur.reasoning = (cur.reasoning || 0) + reasoning;
			cur.cacheRead = (cur.cacheRead || 0) + cacheRead;
			cur.cacheWrite = (cur.cacheWrite || 0) + cacheWrite;
			cur.requests += 1;
			if (durationSec > 0 && output > 0) {
				cur.tokPerSecSum = (cur.tokPerSecSum || 0) + Math.round(output / durationSec);
				cur.tokPerSecCount = (cur.tokPerSecCount || 0) + 1;
			}
			// 按模型维度统计（看板"今日模型消耗占比"）
			if (model) {
				cur.models = cur.models || {};
				const m = cur.models[model] || (cur.models[model] = { input: 0, output: 0 });
				m.input += input;
				m.output += output;
			}
			await env.KV.put(dailyKey, JSON.stringify(cur), { expirationTtl: TOKEN_KV_TTL_SEC });

			// 月度统计（累加模式）
			const monthlyKey = getTokenMonthlyKey();
			const monthlyRaw = await env.KV.get(monthlyKey);
			const monthly = monthlyRaw ? JSON.parse(monthlyRaw) : { input: 0, output: 0, reasoning: 0, requests: 0 };
			monthly.input += input;
			monthly.output += output;
			monthly.reasoning = (monthly.reasoning || 0) + reasoning;
			monthly.requests += 1;
			await env.KV.put(monthlyKey, JSON.stringify(monthly), { expirationTtl: 32 * 86400 });
		} catch (e) {
			console.error('Failed to accumulate tokens:', e?.message || e);
		}
	})());
}

// 从 usage 对象提取字段并累加 token 统计
function accumulateFromUsage(env, ctx, usage, requestStartTime, model = null) {
	if (!ctx || !usage) return;
	const pd = usage.prompt_tokens_details || {};
	accumulateTokens(env, ctx, {
		input: usage.prompt_tokens || 0,
		output: usage.completion_tokens || 0,
		reasoning: usage.reasoning_tokens || 0,
		cacheRead: pd.cached_tokens ?? usage.cache_read_tokens ?? 0,
		cacheWrite: usage.cache_write_tokens || 0,
		durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
		model,
	});
}

async function getTodayTokenStats(env) {
	const key = getTokenDailyKey();
	let kvData = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 0, tokPerSecSum: 0, tokPerSecCount: 0 };
	try {
		const raw = await env.KV.get(key);
		if (raw) kvData = JSON.parse(raw);
	} catch (e) { console.error('Failed to read token stats:', e?.message || e); }

	const avgTokPerSec = (kvData.tokPerSecCount || 0) > 0 ? Math.round((kvData.tokPerSecSum || 0) / (kvData.tokPerSecCount || 0)) : 0;

	return {
		input: kvData.input || 0,
		output: kvData.output || 0,
		reasoning: kvData.reasoning || 0,
		cacheRead: kvData.cacheRead || 0,
		cacheWrite: kvData.cacheWrite || 0,
		total: (kvData.input || 0) + (kvData.output || 0),
		requests: kvData.requests || 0,
		avgTokPerSec,
	};
}

// 找不到模型映射时的兜底模型
const DEFAULT_FALLBACK_MODEL = '@cf/zai-org/glm-4.7-flash';

// 响应头只允许 Latin-1，含中文等非 Latin-1 字符时 Headers 构造会抛 TypeError → 全局 500
function sanitizeHeaderValue(v) {
	if (!v) return v;
	return v.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

// 默认模型映射表（lxchat：已移除 glm-5.3/deepseek 两系/kimi-k2.7-code 等模型）
const DEFAULT_MODEL_MAP = {
	// 对话 / 文本生成模型
	'glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
	'kimi-k2.6': '@cf/moonshotai/kimi-k2.6',
	'gemma-4-26b-a4b-it': '@cf/google/gemma-4-26b-a4b-it',
	'gemma-sea-lion-v4-27b-it': '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
	'nemotron-3-120b-a12b': '@cf/nvidia/nemotron-3-120b-a12b',
	'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
	'gpt-oss-120b': '@cf/openai/gpt-oss-120b',
	'llama-3.1-8b-instruct-fast': '@cf/meta/llama-3.1-8b-instruct-fast',
	'llama-3.2-1b-instruct': '@cf/meta/llama-3.2-1b-instruct',
	'llama-3.2-3b': '@cf/meta/llama-3.2-3b-instruct',
	'llama-3.2-11b-vision-instruct': '@cf/meta/llama-3.2-11b-vision-instruct',
	'llama-3.3-70b-instruct-fp8-fast': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
	'llama-4-scout-17b-16e-instruct': '@cf/meta/llama-4-scout-17b-16e-instruct',
	'qwen3-30b-a3b-fp8': '@cf/qwen/qwen3-30b-a3b-fp8',
	'qwq-32b': '@cf/qwen/qwq-32b',
	'qwen3.8-27b': '@cf/qwen/qwen3.8-27b',
	'mistral-small-3.1-24b-instruct': '@cf/mistral/mistral-small-3.1-24b-instruct',
	'granite-4.0-h-micro': '@cf/ibm/granite-4.0-h-micro',

	// 向量嵌入（Embeddings）模型
	'embeddinggemma-300m': '@cf/google/embeddinggemma-300m',
	'qwen3-embedding-0.6b': '@cf/qwen/qwen3-embedding-0.6b',
	'bge-m3': '@cf/baai/bge-m3',
	'bge-large-en': '@cf/baai/bge-large-en-v1.5',

	// 多模态模型
	'llava-1.5-7b': '@cf/llava-hf/llava-1.5-7b-hf',
	'flux-1-schnell': '@cf/black-forest-labs/flux-1-schnell',
	'flux': '@cf/black-forest-labs/flux-1-schnell',
	'sdxl': '@cf/stabilityai/stable-diffusion-xl-base-1.0',

	// 语音识别（Whisper）模型
	'whisper': '@cf/openai/whisper',
	'whisper-tiny-en': '@cf/openai/whisper-tiny-en',
	'whisper-large-v3-turbo': '@cf/openai/whisper-large-v3-turbo',
	'nova-3': '@cf/deepgram/nova-3',

	// 视觉模型
	'moondream3.1-9B-A2B': '@cf/moondream/moondream3.1-9B-A2B',

	// 向量嵌入（Embeddings）模型补充
	'bge-base-en-v1.5': '@cf/baai/bge-base-en-v1.5',
	'bge-reranker-base': '@cf/baai/bge-reranker-base',

	// 文本转语音（TTS）模型
	'tts': '@cf/deepgram/aura-2-en',
	'aura-2-en': '@cf/deepgram/aura-2-en'
};

// 默认模型 token 上限（lxchat：已移除被拦截模型的 token 配置）
const DEFAULT_MODEL_TOKENS = {
	'@cf/zai-org/glm-4.7-flash': 131072,
	'@cf/moonshotai/kimi-k2.6': 262144,
	'@cf/google/gemma-4-26b-a4b-it': 131072,
	'@cf/aisingapore/gemma-sea-lion-v4-27b-it': 131072,
	'@cf/nvidia/nemotron-3-120b-a12b': 256000,
	'@cf/meta/llama-3.1-8b-instruct-fast': 131072,
	'@cf/meta/llama-3.2-1b-instruct': 131072,
	'@cf/meta/llama-3.2-11b-vision-instruct': 131072,
	'@cf/meta/llama-4-scout-17b-16e-instruct': 131000,
	'@cf/meta/llama-3.3-70b-instruct-fp8-fast': 24000,
	'@cf/qwen/qwen3-30b-a3b-fp8': 32768,
	'@cf/qwen/qwq-32b': 32768,
	'@cf/qwen/qwen3.8-27b': 131072,
	'@cf/mistral/mistral-small-3.1-24b-instruct': 131072,
	'@cf/ibm/granite-4.0-h-micro': 131072,
};

// 从 @cf/ 模型路径提取 owned_by（如 @cf/meta/xxx → meta），无需维护前缀表
function getModelOwnedBy(cfModel, id) {
	if (cfModel.startsWith('@cf/')) {
		const parts = cfModel.slice(4).split('/');
		return parts[0] || 'system';
	}
	if (id.includes('embedding')) return 'openai';
	return 'system';
}

export default {
	async fetch(request, env, ctx) {
		try {
			// 1. 检查是否绑定了 KV 存储
			if (!env.KV) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('KV storage not configured. Please bind a KV namespace named \'KV\' in your Worker settings.', 503, 'server_error');
				}
				return new Response('KV storage not configured. Please bind a KV namespace named \'KV\' in your Worker settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 2. 检查是否配置了 ADMIN_PASSWORD 环境变量
			if (!env.ADMIN_PASSWORD) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('ADMIN_PASSWORD not configured. Please set this environment variable in your Worker settings.', 503, 'server_error');
				}
				return new Response('ADMIN_PASSWORD not configured. Please set this environment variable in your Worker settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 3. 检查是否绑定了 AI binding
			if (!env.AI) {
				const url = new URL(request.url);
				if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
					return jsonError('AI binding not configured. Please bind a Workers AI binding named \'AI\' in your Worker settings.', 503, 'server_error');
				}
				return new Response('AI binding not configured. Please bind a Workers AI binding named \'AI\' in your Worker settings.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}

			// 处理跨域预检请求（OPTIONS）
			if (request.method === 'OPTIONS') {
				const reqUrl = new URL(request.url);
				const isApiPath = reqUrl.pathname.startsWith('/api/');
				const origin = request.headers.get('Origin');
				const allowOrigin = (isApiPath && origin && origin === reqUrl.origin) ? origin
					: (isApiPath && (!origin || origin !== reqUrl.origin)) ? 'null'
					: '*';
				return new Response(null, {
					headers: {
						'Access-Control-Allow-Origin': allowOrigin,
						'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
						'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
						...(isApiPath && allowOrigin !== 'null' ? { 'Vary': 'Origin' } : {})
					}
				});
			}

			const url = new URL(request.url);

			// 4. OpenAI 兼容的代理接口（/v1/ 开头）
			if (url.pathname.startsWith('/v1/')) {
				const response = await handleV1Proxy(request, env, ctx);
				return addCORSHeaders(response, request);
			}

			// 5. 后台管理面板的 API 接口（/api/ 开头）
			if (url.pathname.startsWith('/api/')) {
				const response = await handleDashboardApi(request, env, ctx);
				return addCORSHeaders(response, request);
			}

			// 6. 后台管理面板页面
			if (url.pathname === '/admin' || url.pathname === '/admin/') {
				const isLoggedIn = await checkAdminAuth(request, env);
				if (isLoggedIn) {
					return handleAdminPage(request, env, ctx);
				} else {
					return new Response(null, {
						status: 302,
						headers: { 'Location': '/' }
					});
				}
			}

			// 7. 首页 / 登录页
			if (url.pathname === '/') {
				return handleLandingPage(request, env, ctx);
			}

			// robots.txt
			if (url.pathname === '/robots.txt') {
				return new Response('User-agent: *\nDisallow: /', {
					headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Request-Id': generateRequestId() }
				});
			}

			// 8. 其他路径一律返回 404
			return new Response('404 Not Found', { status: 404, headers: { 'X-Request-Id': generateRequestId() } });
		} catch (e) {
			console.error(`Unhandled error: ${e?.message || e}`);
			return jsonError('Internal Server Error', 500, 'server_error');
		}
	}
};

// ===== 工具函数 =====

function addCORSHeaders(response, request) {
	const newResponse = new Response(response.body, response);
	if (!newResponse.headers.has('X-Request-Id')) {
		newResponse.headers.set('X-Request-Id', generateRequestId());
	}
	newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
	newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
	try {
		const url = new URL(request.url);
		if (url.pathname.startsWith('/api/')) {
			const origin = request.headers.get('Origin');
			if (origin && origin === url.origin) {
				newResponse.headers.set('Access-Control-Allow-Origin', origin);
				newResponse.headers.set('Vary', 'Origin');
			}
		} else {
			newResponse.headers.set('Access-Control-Allow-Origin', '*');
		}
	} catch (_) {
		newResponse.headers.set('Access-Control-Allow-Origin', '*');
	}
	return newResponse;
}

async function sha256(message) {
	const msgBuffer = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// KV 工具函数
function createKVGetter(kvKey, defaultValue) {
	let _promise = null;
	let _promiseTime = 0;
	const fn = async function(env) {
		const now = Date.now();
		if (_promise && (now - _promiseTime) < 60000) return _promise;
		_promise = (async () => {
			const raw = await env.KV.get(kvKey, { cacheTtl: 60 });
			return safeJSONParse(raw, defaultValue);
		})();
		_promiseTime = now;
		try { return await _promise; } finally { /* keep for 60s */ }
	};
	fn.invalidate = () => { _promise = null; _promiseTime = 0; };
	return fn;
}
const getApiKeys = createKVGetter('cfg_api_keys', []);
const getCustomModelMap = createKVGetter('cfg_model_map', {});
const getModelTokens = createKVGetter('cfg_model_tokens', {});
const getUsageLimitsConfig = createKVGetter('cfg_limits', {});
// 模式B账号配置（共用KV，模式A读取用于 GraphQL 真实 Neurons 查询，不写入）
const getAccounts = createKVGetter('cfg_accounts', []);

async function saveUsageLimitsConfig(env, limits) {
	const existing = await getUsageLimitsConfig(env);
	const merged = { ...existing, ...limits };
	await env.KV.put('cfg_limits', JSON.stringify(merged));
	getUsageLimitsConfig.invalidate();
}

async function saveCustomModelMap(env, map) {
	await env.KV.put('cfg_model_map', JSON.stringify(map));
	getCustomModelMap.invalidate();
}

async function saveModelTokens(env, tokens) {
	await env.KV.put('cfg_model_tokens', JSON.stringify(tokens));
	getModelTokens.invalidate();
}

async function saveApiKeys(env, keys) {
	await env.KV.put('cfg_api_keys', JSON.stringify(keys));
	getApiKeys.invalidate();
}

const COOKIE_TOKEN_RE = /admin_token=([^;]+)/;

function maskTokenKey(key) {
	if (!key) return '';
	if (key.length <= 4) return '*'.repeat(key.length);
	if (key.length <= 8) return key.slice(0, 2) + '****' + key.slice(-2);
	return key.slice(0, 4) + '**********' + key.slice(-4);
}

function timingSafeEqual(a, b) {
	if (a.length !== b.length) return false;
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

// 缓存 ADMIN_PASSWORD 的 SHA-256 哈希
let _cachedAdminHash = null;
let _cachedAdminPassword = null;

async function checkAdminAuth(request, env) {
	const cookies = request.headers.get('Cookie') || '';
	const cookieMatch = cookies.match(COOKIE_TOKEN_RE);
	let token = cookieMatch ? cookieMatch[1] : null;

	if (!token) {
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			token = authHeader.substring(7);
		}
	}

	if (!token) return false;

	const expectedPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.trim() : '';

	if (!expectedPassword) return false;

	if (_cachedAdminHash === null || _cachedAdminPassword !== expectedPassword) {
		_cachedAdminHash = await sha256(expectedPassword);
		_cachedAdminPassword = expectedPassword;
	}
	return timingSafeEqual(token, _cachedAdminHash);
}

async function checkProxyAuth(request, env) {
	const apiKeys = await getApiKeys(env);
	if (apiKeys.length === 0) {
		return true;
	}

	const xApiKey = request.headers.get('x-api-key');
	if (xApiKey && apiKeys.some(k => timingSafeEqual(k.key, xApiKey))) {
		return true;
	}

	const authHeader = request.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.substring(7);
		return apiKeys.some(k => timingSafeEqual(k.key, token));
	}

	return false;
}

function jsonError(message, status = 500, type = 'server_error', code = null, param = null) {
	const errBody = { error: { message, type } };
	if (code !== null) errBody.error.code = code;
	if (param !== null) errBody.error.param = param;
	const reqId = generateRequestId();
	return new Response(JSON.stringify(errBody), {
		status,
		headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId }
	});
}

function methodNotAllowed(allowedMethods) {
	const allow = Array.isArray(allowedMethods) ? allowedMethods.join(', ') : allowedMethods;
	const reqId = generateRequestId();
	return new Response(JSON.stringify({
		error: { message: `Method not allowed. Allowed: ${allow}`, type: 'invalid_request_error', code: 'method_not_allowed' }
	}), {
		status: 405,
		headers: { 'Content-Type': 'application/json', 'X-Request-Id': reqId, 'Allow': allow }
	});
}

function anthropicError(message, status = 400) {
	return new Response(JSON.stringify({
		type: 'error',
		error: { type: 'invalid_request_error', message }
	}), { status, headers: { 'Content-Type': 'application/json' } });
}

function generateRequestId() {
	return 'req_' + crypto.randomUUID();
}

function readWithTimeout(reader, timeoutMs, { cancelOnTimeout = false } = {}) {
	let timer;
	const read = reader.read();
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			if (cancelOnTimeout) { try { reader.cancel(); } catch (_) {} }
			reject(new Error(cancelOnTimeout ? 'Initial read timed out' : 'Stream read timed out'));
		}, timeoutMs);
	});
	return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

function getEnvNum(env, key, defaultVal, parseFn) {
	const raw = env[key];
	if (raw == null || raw === '') return defaultVal;
	const val = parseFn(raw);
	return isNaN(val) ? defaultVal : val;
}

// 读取日/月限额和阈值配置（优先级：环境变量 > KV > 默认值）
async function getUsageLimits(env) {
	const kvLimits = await getUsageLimitsConfig(env);

	return {
		dailyLimit: getEnvNum(env, 'DAILY_LIMIT', kvLimits.dailyLimit ?? DEFAULT_DAILY_LIMIT, parseInt),
		monthlyLimit: getEnvNum(env, 'MONTHLY_LIMIT', kvLimits.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT, parseInt),
		threshold: getEnvNum(env, 'USAGE_THRESHOLD', kvLimits.threshold ?? DEFAULT_USAGE_THRESHOLD, parseFloat)
	};
}

function getMonthlyUsageKey() {
	const now = new Date();
	return `usage_monthly_${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function getMonthlyUsage(env) {
	const raw = await env.KV.get(getMonthlyUsageKey());
	return raw ? parseInt(raw, 10) : 0;
}

// ===== 模式A真实用量（与模式B同口径：CF GraphQL Analytics API 查询真实 Neurons） =====
// 模式A此前从 tokens_daily_*（本地token统计）读取用量，与模式B（CF GraphQL真实Neurons）口径不一致：
// 1) token数≠Neurons（CF按模型计费神经元，与token不是1:1）；2) 模式A无法感知模式B请求。
// 修复：模式A看板同样走 GraphQL 查询真实 Neurons（AI Binding 计入同一账户的 aiInferenceAdaptiveGroups）。

function browserHeaders(token, contentType = 'application/json') {
	const headers = {
		'Authorization': `Bearer ${token}`,
		'Accept': 'application/json',
	};
	if (contentType) headers['Content-Type'] = contentType;
	return headers;
}

async function queryGraphQL(accountId, apiToken, startDateTime) {
	const query = `
		query GetAIUsage($accountId: String!, $start: String!) {
			viewer {
				accounts(filter: { accountTag: $accountId }) {
					aiInferenceAdaptiveGroups(
						filter: { datetime_geq: $start }
						limit: 1000
					) {
						count
						sum {
							totalNeurons
						}
						dimensions {
							date
							modelId
						}
					}
				}
			}
		}
	`;
	const response = await fetch(`https://api.cloudflare.com/client/v4/graphql`, {
		method: 'POST',
		headers: browserHeaders(apiToken),
		body: JSON.stringify({
			query,
			variables: {
				accountId,
				start: startDateTime
			}
		}),
		signal: AbortSignal.timeout(20000),
	});

	if (!response.ok) {
		throw new Error(`GraphQL API error: ${response.statusText}`);
	}

	const result = await response.json();
	if (result.errors && result.errors.length > 0) {
		throw new Error(result.errors[0].message);
	}

	return result?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
}

function processAnalytics(groups) {
	const todayStr = getTodayStr();

	let todayTotalNeurons = 0, todayTotalRequests = 0;
	const todayModelsMap = {}, historyMap = {}, historyRequestsMap = {};

	// 先把最近 7 天的历史数据全部初始化为 0
	for (let i = 6; i >= 0; i--) {
		const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const dStr = d.toISOString().split('T')[0];
		historyMap[dStr] = 0;
		historyRequestsMap[dStr] = 0;
	}

	for (const group of groups) {
		const date = group.dimensions.date;
		const model = group.dimensions.modelId;
		const neurons = group.sum?.totalNeurons || 0;
		const count = group.count || 0;

		if (date === todayStr) {
			todayTotalNeurons += neurons;
			todayTotalRequests += count;
			if (!todayModelsMap[model]) {
				todayModelsMap[model] = { model, neurons: 0, requests: 0 };
			}
			todayModelsMap[model].neurons += neurons;
			todayModelsMap[model].requests += count;
		}

		if (historyMap[date] !== undefined) {
			historyMap[date] += neurons;
			historyRequestsMap[date] += count;
		}
	}

	const todayModels = Object.values(todayModelsMap).sort((a, b) => b.neurons - a.neurons);
	const history = Object.keys(historyMap)
		.sort()
		.map(date => ({ date, neurons: historyMap[date], requests: historyRequestsMap[date] }));

	return {
		todayTotalNeurons,
		todayTotalRequests,
		todayModels,
		history
	};
}

// 刷新模式B账号列表的 GraphQL 用量缓存（cache_usage_details），与模式B refreshAccountsUsage 同逻辑。
// 模式A共用同一KV，读同一缓存键保证两模式看板一致。
async function refreshAccountsUsage(env, accounts, limit = USAGE_REFRESH_LIMIT) {
	const cachedDetailsRaw = await env.KV.get('cache_usage_details');
	let cacheMap = {};
	if (cachedDetailsRaw) {
		try {
			cacheMap = JSON.parse(cachedDetailsRaw) || {};
		} catch (e) {
			cacheMap = {};
		}
	}

	// 按最后更新时间升序，优先更新最旧数据
	const sortedAccounts = [...accounts].sort((a, b) => {
		const tA = cacheMap[a.id]?.timestamp || 0;
		const tB = cacheMap[b.id]?.timestamp || 0;
		return tA - tB;
	});

	const accountsToUpdate = sortedAccounts.slice(0, limit);

	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	sevenDaysAgo.setUTCHours(0, 0, 0, 0);
	const startSevenDays = sevenDaysAgo.toISOString().split('.')[0] + 'Z';

	const todayUTC = new Date();
	todayUTC.setUTCHours(0, 0, 0, 0);

	// 月初日期
	const monthStart = new Date(Date.UTC(todayUTC.getUTCFullYear(), todayUTC.getUTCMonth(), 1));
	const startMonth = monthStart.toISOString().split('.')[0] + 'Z';

	for (const account of accountsToUpdate) {
		try {
			// 7 天窗口单次查询，提取今日+历史数据
			const historyGroups = await queryGraphQL(account.accountId, account.apiToken, startSevenDays);
			const historyParsed = processAnalytics(historyGroups);

			const todayUsage = historyParsed.todayTotalNeurons;
			const todayRequests = historyParsed.todayTotalRequests;
			const todayModels = historyParsed.todayModels;
			const todayDateStr = getTodayStr();

			// 月初在窗口内则从同一查询提取，否则独立查
			let monthlyTotal;
			let monthlyRequests = 0;
			const monthStartStr = monthStart.toISOString().split('T')[0];
			if (historyParsed.history.some(h => h.date === monthStartStr)) {
				// 汇总本月数据
				monthlyTotal = historyGroups.reduce((sum, g) => {
					if (g.dimensions.date >= monthStartStr) return sum + (g.sum?.totalNeurons || 0);
					return sum;
				}, 0);
				monthlyRequests = historyGroups.reduce((sum, g) => {
					if (g.dimensions.date >= monthStartStr) return sum + (g.count || 0);
					return sum;
				}, 0);
			} else {
				// 月初不在窗口内，独立查询
				const monthGroups = await queryGraphQL(account.accountId, account.apiToken, startMonth)
					.catch(e => {
						// 仅记录账号名与错误消息，避免异常对象可能携带请求头/token 被 tail workers 捕获
						console.error(`Monthly query failed for ${account.name}: ${e?.message || e}`);
						return null;
					});
				if (monthGroups) {
					monthlyTotal = monthGroups.reduce((sum, g) => sum + (g.sum?.totalNeurons || 0), 0);
					monthlyRequests = monthGroups.reduce((sum, g) => sum + (g.count || 0), 0);
				} else {
					monthlyTotal = cacheMap[account.id]?.usageThisMonth || 0;
					monthlyRequests = cacheMap[account.id]?.usageThisMonthRequests || 0;
				}
			}

			cacheMap[account.id] = {
				status: 'active',
				error: null,
				todayDate: todayDateStr,
				usageToday: todayUsage,
				usageTodayRequests: todayRequests,
				modelsToday: todayModels,
				history: historyParsed.history,
				usageThisMonth: monthlyTotal,
				usageThisMonthRequests: monthlyRequests,
				timestamp: Date.now()
			};
		} catch (e) {
			// 仅记录账号名与错误消息，避免异常对象可能携带请求头/token 被 tail workers 捕获
			console.error(`Error querying GraphQL for ${account.name}: ${e?.message || e}`);
			cacheMap[account.id] = {
				status: 'error',
				error: e.message,
				todayDate: cacheMap[account.id]?.todayDate || '',
				usageToday: cacheMap[account.id]?.usageToday || 0,
				usageTodayRequests: cacheMap[account.id]?.usageTodayRequests || 0,
				modelsToday: cacheMap[account.id]?.modelsToday || [],
				history: cacheMap[account.id]?.history || [],
				usageThisMonth: cacheMap[account.id]?.usageThisMonth || 0,
				usageThisMonthRequests: cacheMap[account.id]?.usageThisMonthRequests || 0,
				timestamp: Date.now() // 即使出错也更新时间戳，以便其他账号轮转刷新
			};
		}
		// 串行查询，每个账号之间加间隔，避免触发风控
		await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
	}
	await env.KV.put('cache_usage_details', JSON.stringify(cacheMap));

	// 汇总月度用量写入 KV
	let totalMonthly = 0;
	for (const [, data] of Object.entries(cacheMap)) {
		totalMonthly += data.usageThisMonth || 0;
	}
	await env.KV.put(getMonthlyUsageKey(), String(totalMonthly), { expirationTtl: MONTHLY_USAGE_TTL_SEC });

	return cacheMap;
}

// 用量限额检查（简化版：从 token 统计 KV 获取用量）
async function checkUsageLimit(env) {
	const { dailyLimit, monthlyLimit, threshold } = await getUsageLimits(env);

	// threshold <= 0 表示关闭限额拦截：短路返回，跳过用量 KV 读取（性能优化）
	if (threshold <= 0) {
		return { allowed: true, dailyUsage: 0, dailyLimit, monthlyUsage: 0, monthlyLimit, threshold };
	}

	// 当日用量从 token 统计 KV 获取
	const stats = await getTodayTokenStats(env);
	const dailyUsage = stats.total;

	const monthlyUsage = await getMonthlyUsage(env);

	const dailyExceeded = dailyUsage >= dailyLimit * threshold;
	const monthlyExceeded = monthlyUsage >= monthlyLimit * threshold;

	if (dailyExceeded || monthlyExceeded) {
		const reason = dailyExceeded
			? `Daily usage (${dailyUsage}/${dailyLimit}) exceeds ${Math.round(threshold * 100)}% threshold`
			: `Monthly usage (${monthlyUsage}/${monthlyLimit}) exceeds ${Math.round(threshold * 100)}% threshold`;
		return { allowed: false, reason, dailyUsage, dailyLimit, monthlyUsage, monthlyLimit, threshold };
	}
	return { allowed: true, dailyUsage, dailyLimit, monthlyUsage, monthlyLimit, threshold };
}

// ===== P0: Workers AI 错误码映射 + friendlyError =====
// 来源: https://developers.cloudflare.com/workers-ai/platform/errors/
const WORKERS_AI_ERROR_CODE_TO_STATUS = {
	5007: 400, // No such model
	5004: 400, // Invalid data
	3039: 400, // Finetune missing required files
	3003: 400, // Incomplete request
	5018: 403, // Account not allowed for private model
	5016: 403, // Model agreement not accepted
	3023: 403, // Account blocked
	3041: 403, // Account not allowed for private model
	5019: 405, // Deprecated SDK version
	5005: 405, // LoRa unsupported
	3042: 404, // Invalid model ID
	3006: 413, // Request too large
	3007: 408, // Timeout
	3008: 408, // Aborted
	3036: 429, // Account limited (daily free allocation used up)
	3040: 429, // Out of capacity (no data center to forward to)
};

function parseWorkersAIErrorCode(error) {
	if (error && typeof error === 'object') {
		const code = error.code;
		if (typeof code === 'number' && code in WORKERS_AI_ERROR_CODE_TO_STATUS) return code;
		if (typeof code === 'string') {
			const parsed = parseInt(code, 10);
			if (Number.isFinite(parsed) && parsed in WORKERS_AI_ERROR_CODE_TO_STATUS) return parsed;
		}
	}
	const msg = (error instanceof Error ? error.message : String(error || ''));
	for (const match of msg.matchAll(/\b(\d{3,5})\s*:/g)) {
		const parsed = parseInt(match[1], 10);
		if (parsed in WORKERS_AI_ERROR_CODE_TO_STATUS) return parsed;
	}
	return undefined;
}

function isCapacityError(e) {
	const low = String((e && e.message) || e).toLowerCase();
	if (low.includes('8007') || low.includes('badrequest')) return false;
	return low.includes('capacity') || low.includes('3040') || low.includes('429') || low.includes('overload')
		|| low.includes('3046') || low.includes('request timeout')
		|| low.includes('3021') || low.includes('per min rate') || low.includes('per-min rate')
		|| low.includes('internal server error')
		|| low.includes('network connection lost') || low.includes('connection reset')
		|| low.includes('connection refused') || low.includes('connection error')
		|| low.includes('fetch failed') || low.includes('network error');
}

function friendlyError(e) {
	const m = String((e && e.message) || e); const low = m.toLowerCase();
	if (low.includes('longer than') || (low.includes('context') && low.includes('length')) || low.includes('too long') || low.includes('5021'))
		return { status: 400, type: 'invalid_request_error', message: '上下文过长，请精简后重试。' };
	if (low.includes('unexpected end of data') || low.includes('must be valid json') || low.includes('arguments must be valid'))
		return { status: 400, type: 'invalid_request_error', message: '对话历史有一步的工具调用数据损坏/不完整（不可重试）；请开新会话后重试。' };
	if (low.includes('8007') || low.includes('badrequest'))
		return { status: 400, type: 'invalid_request_error', message: '请求被上游拒绝（数据不合法，不可重试）；请重置对话后重试。' };
	if (low.includes('queue full') || low.includes('queue timeout'))
		return { status: 429, type: 'rate_limit_error', message: '请求过于密集，请稍后重试。' };
	if (low.includes('empty response'))
		return { status: 503, type: 'overloaded_error', message: '服务繁忙（上游空响应），请稍后重试。' };
	if (low.includes('first token timeout') || low.includes('prefill timeout') || low.includes('upstream stalled'))
		return { status: 503, type: 'overloaded_error', message: '服务繁忙（上游响应超时），请稍后重试。' };
	if (low.includes('3021') || low.includes('per min rate') || low.includes('per-min rate') || (low.includes('rate limit') && low.includes('inference')))
		return { status: 429, type: 'rate_limit_error', message: '上游繁忙（每分钟推理限速），请稍后重试。' };
	if (low.includes('4006') || low.includes('1027') || low.includes('free allocation') || low.includes('daily free'))
		return { status: 429, type: 'rate_limit_error', message: '这个通道当前调用不了，我们正在处理，可稍后重试或联系客服换通道。' };
	if (isCapacityError(e))
		return { status: 503, type: 'overloaded_error', message: '服务繁忙，请稍后重试。' };
	// 结构兜底：内嵌 4xx 码或 BadRequest/invalid 类 type → 不可重试的 400
	const codeMatch = m.match(/"code"\s*:\s*(\d{3})\b/);
	const embeddedCode = codeMatch ? Number(codeMatch[1]) : null;
	const typeMatch = m.match(/"type"\s*:\s*"([^"]+)"/);
	const embeddedType = typeMatch ? typeMatch[1].toLowerCase() : '';
	if (embeddedCode === 429) return { status: 429, type: 'rate_limit_error', message: '上游繁忙，请稍后重试。' };
	if ((embeddedCode !== null && embeddedCode >= 400 && embeddedCode <= 499)
		|| embeddedType.includes('badrequest') || embeddedType.includes('invalid')
		|| embeddedType.includes('unprocessable') || embeddedType.includes('notfound')
		|| embeddedType.includes('unsupported'))
		return { status: 400, type: 'invalid_request_error', message: '请求被上游拒绝（数据不合法，不可重试）；请重置对话后重试。' };
	return { status: 500, type: 'api_error', message: '调用失败（未识别的上游错误），请稍后重试；持续出现请联系管理员。' };
}

// ===== P1: 简化熔断器 Circuit Breaker =====
// isolate 内存态，无 KV/DO；短时间窗口内容量类失败过多 → 开闸快速失败
const CB = { fails: [], openUntil: 0 };
const CB_WINDOW_MS = 10000, CB_FAIL_THRESHOLD = 8, CB_COOLDOWN_MS = 4000;
function cbWindow(env) { return Number(env && env.CB_WINDOW_MS) || CB_WINDOW_MS; }
function cbThreshold(env) { return Number(env && env.CB_FAIL_THRESHOLD) || CB_FAIL_THRESHOLD; }
function cbCooldown(env) { return Number(env && env.CB_COOLDOWN_MS) || CB_COOLDOWN_MS; }
function cbOpen() { return Date.now() < CB.openUntil; }
function cbOnCapacityFail(env) {
	const now = Date.now();
	CB.fails = CB.fails.filter(t => now - t < cbWindow(env));
	CB.fails.push(now);
	if (CB.fails.length >= cbThreshold(env)) { CB.openUntil = now + cbCooldown(env); CB.fails.length = 0; }
}
function cbOnSuccess(env) { CB.fails.length = 0; CB.openUntil = 0; }

// ===== P2: 模型断供快速失败闩 =====
// 连续 MODEL_DOWN_FAILS 条请求首发都是断供错且持续 > MODEL_DOWN_AFTER_MS → 判死，重试降到 0
const MODEL_DOWN = new Map();
const MODEL_DOWN_FAILS = 3, MODEL_DOWN_AFTER_MS = 60000;
function modelDownFails(env) { return Math.max(1, Number(env && env.MODEL_DOWN_FAILS) || MODEL_DOWN_FAILS); }
function modelDownAfterMs(env) { return Number(env && env.MODEL_DOWN_AFTER_MS) || MODEL_DOWN_AFTER_MS; }
function isModelDownError(e) {
	const low = String((e && e.message) || e).toLowerCase();
	if (low.includes('gate full') || low.includes('circuit open')) return false;
	return low.includes('4006') || (e && e.code === 4006) || low.includes('temporarily at capacity');
}
function noteModelFail(model, e) {
	if (!model) return;
	if (!isModelDownError(e)) { MODEL_DOWN.delete(model); return; }
	const s = MODEL_DOWN.get(model) || { fails: 0, firstAt: Date.now() };
	s.fails++;
	if (!s.firstAt) s.firstAt = Date.now();
	MODEL_DOWN.set(model, s);
}
function noteModelOk(model) { if (model) MODEL_DOWN.delete(model); }
function modelDown(env, model) {
	if (!model) return false;
	const s = MODEL_DOWN.get(model);
	if (!s) return false;
	return s.fails >= modelDownFails(env) && Date.now() - s.firstAt >= modelDownAfterMs(env);
}

// ===== P3: 令牌估算 + 过大闸 =====
const CJK_TOKEN_WEIGHT = 0.6;
const OVERSIZE_TOKENS = 200000;

function estimateTokens(s) {
	let cjk = 0, other = 0;
	for (const ch of s) {
		const c = ch.codePointAt(0);
		if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0x3040 && c <= 0x30FF)
			|| (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0x20000 && c <= 0x2FA1F))
			cjk++;
		else other++;
	}
	return Math.ceil(cjk * CJK_TOKEN_WEIGHT + other / 4);
}

function estimateJsonTokens(value) {
	try { return Math.ceil((typeof value === 'string' ? value : JSON.stringify(value)).length / 4); }
	catch { return 0; }
}

function estimateContentTokens(c) {
	if (typeof c === 'string') return estimateTokens(c);
	if (Array.isArray(c)) return c.reduce((n, x) => n + estimateContentPartTokens(x), 0);
	return estimateContentPartTokens(c);
}

function estimateContentPartTokens(c) {
	if (typeof c === 'string') return estimateTokens(c);
	if (!c || typeof c !== 'object') return 0;
	let n = 0;
	if (typeof c.text === 'string') n += estimateTokens(c.text);
	if (typeof c.input_text === 'string') n += estimateTokens(c.input_text);
	if (typeof c.output === 'string') n += estimateTokens(c.output);
	if (Array.isArray(c.content)) n += estimateContentTokens(c.content);
	else if (c.content != null) n += estimateTokens(String(c.content));
	if (c.input != null) n += estimateJsonTokens(c.input);
	return n;
}

function estimateReqTokens(options) {
	if (!options || typeof options !== 'object') return 0;
	let n = 0;
	n += estimateContentTokens(options.system);
	n += estimateContentTokens(options.instructions);
	for (const m of (options.messages) || []) {
		if (!m) continue;
		n += estimateContentTokens(m.content);
		if (m.tool_calls) n += estimateJsonTokens(m.tool_calls);
	}
	if (options.tools) n += estimateJsonTokens(options.tools);
	return n;
}

function oversizeTokenLimit(env, modelTokens) {
	const n = Number(env && env.OVERSIZE_TOKENS);
	if (Number.isFinite(n) && n >= 0) return Math.floor(n);
	if (Number.isFinite(modelTokens) && modelTokens > 0) return Math.floor(modelTokens);
	return OVERSIZE_TOKENS;
}

function shouldRejectOversize(options, env, modelTokens) {
	const tokenLimit = oversizeTokenLimit(env, modelTokens);
	return tokenLimit > 0 && estimateReqTokens(options) > tokenLimit;
}

// ===== Workers AI Binding 调用函数 =====

// 归一化 AI Binding 非流式响应为 OpenAI 兼容格式
// Binding env.AI.run(model, {messages}) 可能返回原生格式 {response, usage, tool_calls}
// 或 OpenAI 格式 {choices}（取决于模型/版本），统一确保为 OpenAI 格式
function normalizeBindingResult(result, cfModel) {
	// 已是 OpenAI 格式（有 choices 数组）→ 直接返回
	if (result && typeof result === 'object' && Array.isArray(result.choices)) {
		return result;
	}
	// 原生格式 { response: string, usage, tool_calls } → 构造 OpenAI 格式
	if (result && typeof result === 'object' && typeof result.response === 'string') {
		const hasToolCalls = Array.isArray(result.tool_calls) && result.tool_calls.length > 0;
		const message = { role: 'assistant', content: result.response };
		if (hasToolCalls) message.tool_calls = result.tool_calls;
		return {
			id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: cfModel,
			choices: [{
				index: 0,
				message,
				finish_reason: hasToolCalls ? 'tool_calls' : 'stop'
			}],
			usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
		};
	}
	// 兜底：原样返回（可能是字符串或其他未知格式）
	return result;
}

// env.AI.run 第 3 参挂 AI Gateway 选项：gateway.id=ojbkxc（用户已有网关，平台侧记录日志）
// + cacheTtl 3600 响应缓存（相同前缀请求 1 小时内命中缓存，免费返回，长会话场景省额度）
function aiRunOptions(env, base) {
	const gwId = env && env.AI_GATEWAY_ID;
	if (gwId === 'off') return base;
	return { ...base, gateway: { id: gwId || 'ojbkxc', cacheTtl: 3600 } };
}

async function callBindingChat(cfModel, cfPayload, env, stream) {
	// 熔断器开闸 → 快速失败
	if (cbOpen()) {
		const cbErr = new Error('capacity (circuit open)');
		cbErr.code = 'circuit_open';
		return { success: false, status: 503, error: cbErr };
	}
	try {
		if (stream) {
			const inputs = { ...cfPayload, stream: true };
			const resp = await env.AI.run(cfModel, inputs, aiRunOptions(env, { returnRawResponse: true, signal: AbortSignal.timeout(600000) }));
			if (!resp.ok) {
				const errText = await resp.text();
				let parsedErr;
				try { parsedErr = JSON.parse(errText); } catch (_) { parsedErr = { message: errText }; }
				const aiErr = new Error(parsedErr.message || errText);
				if (parsedErr.code) aiErr.code = parsedErr.code;
				aiErr.status = resp.status;
				cbOnCapacityFail(env);
				noteModelFail(cfModel, aiErr);
				return { success: false, status: resp.status, error: aiErr };
			}
			if (!resp.body) {
				return { success: false, status: 502, error: new Error('AI Binding returned empty response body') };
			}
			cbOnSuccess(env);
			noteModelOk(cfModel);
			return { success: true, status: resp.status, stream: resp.body };
		}
		const result = await env.AI.run(cfModel, cfPayload, aiRunOptions(env, { signal: AbortSignal.timeout(120000) }));
		cbOnSuccess(env);
		noteModelOk(cfModel);
		return { success: true, status: 200, data: normalizeBindingResult(result, cfModel) };
	} catch (e) {
		cbOnCapacityFail(env);
		noteModelFail(cfModel, e);
		return { success: false, status: 502, error: e };
	}
}

// ===== 模型名解析 =====
async function resolveModelName(model, env) {
	if (!model) {
		const tokens = DEFAULT_MODEL_TOKENS[DEFAULT_FALLBACK_MODEL] || null;
		return { cfModel: DEFAULT_FALLBACK_MODEL, isFallback: true, tokens };
	}
	if (model.startsWith('@cf/')) {
		const customTokens = await getModelTokens(env);
		const tokens = customTokens[model] || DEFAULT_MODEL_TOKENS[model] || null;
		return { cfModel: model, isFallback: false, tokens };
	}
	const customMap = await getCustomModelMap(env);
	const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };
	const mapped = combinedMap[model];
	if (mapped) {
		const customTokens = await getModelTokens(env);
		const tokens = customTokens[mapped] || DEFAULT_MODEL_TOKENS[mapped] || null;
		return { cfModel: mapped, isFallback: false, tokens };
	}
	const tokens = DEFAULT_MODEL_TOKENS[DEFAULT_FALLBACK_MODEL] || null;
	return { cfModel: DEFAULT_FALLBACK_MODEL, isFallback: true, tokens };
}

// ===== handleV1Proxy =====
async function handleV1Proxy(request, env, ctx) {
	const url = new URL(request.url);

	if (!await checkProxyAuth(request, env)) {
		if (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens') {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'authentication_error',
					message: 'Invalid x-api-key or Authorization header.'
				}
			}), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
		return jsonError("Incorrect or missing API key. Configure keys in the dashboard.", 401, "invalid_request_error", "invalid_api_key");
	}

	const limitCheck = await checkUsageLimit(env);
	if (!limitCheck.allowed) {
		const msg = `Request blocked: ${limitCheck.reason}. Please check your usage dashboard.`;

		if (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens') {
			return new Response(JSON.stringify({
				type: 'error',
				error: { type: 'quota_exceeded', message: msg }
			}), { status: 429, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
		return jsonError(msg, 429, 'quota_exceeded');
	}

	if (url.pathname === '/v1/models' && request.method === 'GET') {
		const customMap = await getCustomModelMap(env);
		const customTokens = await getModelTokens(env);
		const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };

		const modelsData = Object.keys(combinedMap).map(id => {
			const cfModel = combinedMap[id] || '';
			if (!cfModel.startsWith('@cf/')) return null; // 只返回 @cf/ 开头的模型
			const ownedBy = getModelOwnedBy(cfModel, id);
			const tokens = customTokens[cfModel] || DEFAULT_MODEL_TOKENS[cfModel] || 0;
			return {
				id,
				object: 'model',
				created: MODEL_CREATED_TS,
				owned_by: ownedBy,
				_tokens: tokens
			};
		}).filter(Boolean).sort((a, b) => b._tokens - a._tokens).map(({ _tokens, ...rest }) => rest);

		return new Response(JSON.stringify({
			object: 'list',
			data: modelsData
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname.startsWith('/v1/models/') && request.method === 'GET') {
		const modelId = decodeURIComponent(url.pathname.slice('/v1/models/'.length));
		if (!modelId) {
			return jsonError("Model ID is required", 400, "invalid_request_error");
		}

		const customMap = await getCustomModelMap(env);
		const combinedMap = { ...DEFAULT_MODEL_MAP, ...customMap };
		const cfModel = combinedMap[modelId];

		if (!cfModel) {
			return jsonError(`Model '${modelId}' not found`, 404, "model_not_found");
		}

		const ownedBy = getModelOwnedBy(cfModel, modelId);

		return new Response(JSON.stringify({
			id: modelId,
			object: 'model',
			created: MODEL_CREATED_TS,
			owned_by: ownedBy
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	if ((url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions') && request.method === 'POST') {
		return handleCompletions(request, env, ctx, url.pathname);
	}

	if (url.pathname === '/v1/messages' && request.method === 'POST') {
		return handleMessages(request, env, ctx);
	}

	if (url.pathname === '/v1/responses' && request.method === 'POST') {
		return handleResponses(request, env, ctx);
	}

	if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
		return handleEmbeddings(request, env, ctx);
	}

	if (url.pathname === '/v1/images/generations' && request.method === 'POST') {
		return handleImageGenerations(request, env, ctx);
	}

	if (url.pathname === '/v1/audio/transcriptions' && request.method === 'POST') {
		return handleAudioTranscribe(request, env, ctx, false);
	}

	if (url.pathname === '/v1/audio/translations' && request.method === 'POST') {
		return handleAudioTranscribe(request, env, ctx, true);
	}

	if (url.pathname === '/v1/audio/speech' && request.method === 'POST') {
		return handleAudioSpeech(request, env, ctx);
	}

	if (url.pathname === '/v1/messages/count_tokens' && request.method === 'POST') {
		return handleCountTokens(request, env);
	}

	// 405 方法校验
	const methodRoutes = {
		'/v1/models': ['GET'],
		'/v1/chat/completions': ['POST'],
		'/v1/completions': ['POST'],
		'/v1/messages': ['POST'],
		'/v1/responses': ['POST'],
		'/v1/embeddings': ['POST'],
		'/v1/images/generations': ['POST'],
		'/v1/audio/transcriptions': ['POST'],
		'/v1/audio/translations': ['POST'],
		'/v1/audio/speech': ['POST'],
		'/v1/messages/count_tokens': ['POST'],
	};
	if (methodRoutes[url.pathname]) {
		return methodNotAllowed(methodRoutes[url.pathname]);
	}
	if (url.pathname.startsWith('/v1/models/')) {
		return methodNotAllowed(['GET']);
	}

	return jsonError(`Path not found: ${url.pathname}`, 404, "invalid_request_error");
}

// ===== handleCompletions =====
async function handleCompletions(request, env, ctx, pathname) {
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Invalid or missing JSON body", 400, "invalid_request_error");

	const requestStartTime = Date.now();

	const { model, messages, prompt, stream } = body;

	if (pathname === '/v1/chat/completions' && !messages) {
		return jsonError("messages field is required", 400, "invalid_request_error");
	}
	if (pathname === '/v1/completions' && !prompt) {
		return jsonError("prompt field is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback, tokens } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model}" not found in mapping, fell back to ${cfModel}`) : null;
	if (isFallback && model && (env.STRICT_MODEL_MATCH || '').toLowerCase() === 'true') {
		return jsonError(`Model '${model}' not found`, 404, "invalid_request_error", "model_not_found");
	}

	const cfPayload = {
		messages: pathname === '/v1/chat/completions' ? messages : [{ role: 'user', content: prompt }],
		stream: !!stream,
	};

	const passthroughFields = [
		'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'n',
		'stop', 'presence_penalty', 'frequency_penalty',
		'logprobs', 'top_logprobs', 'seed', 'user',
		'tools', 'tool_choice', 'parallel_tool_calls',
		'response_format', 'stream_options',
		'reasoning_effort', 'chat_template_kwargs',
	];
	for (const field of passthroughFields) {
		if (body[field] !== undefined) cfPayload[field] = body[field];
	}

	if (stream && !cfPayload.stream_options) {
		cfPayload.stream_options = { include_usage: true };
	}

	// Token 上限 clamp
	if (tokens) {
		if (cfPayload.max_tokens && cfPayload.max_tokens > tokens) {
			cfPayload.max_tokens = tokens;
		}
		if (cfPayload.max_completion_tokens && cfPayload.max_completion_tokens > tokens) {
			cfPayload.max_completion_tokens = tokens;
		}
	}

	// P3: 过大闸检查（闸值优先级：env 显式配置 > 模型自身 tokens > 默认 20 万）
	if (shouldRejectOversize(cfPayload, env, tokens)) {
		const wan = Math.max(1, Math.round(oversizeTokenLimit(env, tokens) / 10000));
		return jsonError(`上下文过长：一轮最多发 ${wan} 万 token。请在客户端压缩对话或开新会话后重试。`, 400, 'invalid_request_error');
	}

	// P2: 模型断供闩 → 跳过重试直接返回
	if (modelDown(env, cfModel)) {
		const fe = friendlyError(new Error('4006: Service temporarily at capacity'));
		return jsonError(fe.message, fe.status, fe.type);
	}

	const result = await callBindingChat(cfModel, cfPayload, env, stream);

	if (!result.success) {
		const fe = friendlyError(result.error);
		return jsonError(fe.message, fe.status || 502, fe.type);
	}

	if (stream) {
		// For Binding streaming, we get a ReadableStream directly. Wrap it in passthroughStream for SSE processing.
		return streamResponse(
			passthroughStream(result.stream, model, pathname === '/v1/completions', env, ctx, requestStartTime),
			fallbackWarning
		);
	}
	const cfJson = result.data;
	if (cfJson.model !== undefined) cfJson.model = model;
	accumulateFromUsage(env, ctx, cfJson.usage, requestStartTime, model);
	if (pathname === '/v1/completions') {
		const textChoices = (cfJson.choices || []).map(c => ({
			text: c.message?.content || '',
			index: c.index ?? 0,
			logprobs: c.logprobs ?? null,
			finish_reason: c.finish_reason || 'stop'
		}));
		return jsonResponse({
			id: cfJson.id,
			object: 'text_completion',
			created: cfJson.created,
			model: cfJson.model,
			choices: textChoices,
			usage: cfJson.usage
		}, fallbackWarning);
	}
	return jsonResponse(cfJson, fallbackWarning);
}

// ===== Anthropic Messages API → OpenAI Chat Completions 格式转换 =====
function convertAnthropicToOpenAI(anthropicBody) {
	const openaiBody = {};

	openaiBody.model = anthropicBody.model;
	if (anthropicBody.max_tokens !== undefined) openaiBody.max_tokens = anthropicBody.max_tokens;
	if (anthropicBody.stream !== undefined) openaiBody.stream = anthropicBody.stream;
	if (anthropicBody.temperature !== undefined) openaiBody.temperature = anthropicBody.temperature;
	if (anthropicBody.top_p !== undefined) openaiBody.top_p = anthropicBody.top_p;
	if (anthropicBody.stop_sequences !== undefined) openaiBody.stop = anthropicBody.stop_sequences;
	if (anthropicBody.thinking?.type === 'enabled') openaiBody.reasoning_effort = 'high';
	if (anthropicBody.metadata && anthropicBody.metadata.user_id) openaiBody.user = anthropicBody.metadata.user_id;

	const openaiMessages = [];

	if (anthropicBody.system) {
		let systemContent = '';
		if (typeof anthropicBody.system === 'string') {
			systemContent = anthropicBody.system;
		} else if (Array.isArray(anthropicBody.system)) {
			for (const block of anthropicBody.system) {
				if (block.type === 'text' && block.text) {
					systemContent += block.text + '\n';
				}
			}
			systemContent = systemContent.trim();
		}
		if (systemContent) {
			openaiMessages.push({ role: 'system', content: systemContent });
		}
	}

	for (const msg of anthropicBody.messages) {
		const role = msg.role;
		const content = msg.content;

		if (typeof content === 'string') {
			openaiMessages.push({ role, content });
		} else if (Array.isArray(content)) {

			if (role === 'assistant') {
				let textContent = '';
				const toolCalls = [];

				for (const block of content) {
					if (block.type === 'text') {
						textContent += block.text || '';
					} else if (block.type === 'tool_use') {
						toolCalls.push({
							id: block.id,
							type: 'function',
							function: {
								name: block.name,
								arguments: JSON.stringify(block.input || {})
							}
						});
					}
				}

				const assistantMsg = { role: 'assistant', content: textContent || null };
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				openaiMessages.push(assistantMsg);
				continue;
			}

			if (role === 'user') {
				for (const block of content) {
					if (block.type === 'tool_result') {
						let resultContent = '';
						if (typeof block.content === 'string') {
							resultContent = block.content;
						} else if (Array.isArray(block.content)) {
							for (const c of block.content) {
								if (c.type === 'text' && c.text) {
									resultContent += c.text;
								}
							}
						}
						const toolMsg = {
							role: 'tool',
							tool_call_id: block.tool_use_id,
							content: resultContent
						};
						if (block.name) toolMsg.name = block.name;
						openaiMessages.push(toolMsg);
					}
				}

				const openaiContentParts = [];
				for (const block of content) {
					if (block.type === 'text') {
						openaiContentParts.push({ type: 'text', text: block.text || '' });
					} else if (block.type === 'image') {
						const source = block.source || {};
						let imageUrl = '';
						if (source.type === 'url' && source.url) {
							imageUrl = source.url;
						} else if (source.data) {
							const mediaType = source.media_type || 'image/png';
							imageUrl = `data:${mediaType};base64,${source.data}`;
						}
						if (imageUrl) {
							openaiContentParts.push({
								type: 'image_url',
								image_url: { url: imageUrl }
							});
						}
					}
				}

				if (openaiContentParts.length > 0) {
					openaiMessages.push({ role: 'user', content: openaiContentParts });
				}
				continue;
			}

			const openaiContentParts = [];
			for (const block of content) {
				if (block.type === 'text') {
					openaiContentParts.push({ type: 'text', text: block.text || '' });
				}
			}
			if (openaiContentParts.length > 0) {
				openaiMessages.push({ role, content: openaiContentParts });
			}
		}
	}

	const firstNonSystemMsg = openaiMessages.find(m => m.role !== 'system');
	if (firstNonSystemMsg && firstNonSystemMsg.role === 'assistant') {
		const systemCount = openaiMessages.filter(m => m.role === 'system').length;
		openaiMessages.splice(systemCount, 0, {
			role: 'user',
			content: ' '
		});
	}

	openaiBody.messages = openaiMessages;

	if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
		openaiBody.tools = anthropicBody.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description || '',
				parameters: tool.input_schema || {}
			}
		}));
	}

	if (anthropicBody.tool_choice) {
		const tc = anthropicBody.tool_choice;
		const type = typeof tc === 'string' ? tc : tc.type;
		if (type === 'auto') {
			openaiBody.tool_choice = 'auto';
		} else if (type === 'any') {
			openaiBody.tool_choice = 'required';
		} else if (type === 'none') {
			openaiBody.tool_choice = 'none';
		} else if (type === 'tool' && tc.name) {
			openaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
		}
	}

	return openaiBody;
}

// ===== OpenAI Chat Completion 响应 → Anthropic Messages 格式转换 =====
function convertOpenAIToAnthropic(openaiResponse, originalModel, stopSequences) {
	const choice = openaiResponse.choices?.[0] || {};
	const message = choice.message || {};

	const anthropicResponse = {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		content: [],
		model: originalModel,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: openaiResponse.usage?.prompt_tokens || 0,
			output_tokens: openaiResponse.usage?.completion_tokens || 0,
			cache_creation_input_tokens: openaiResponse.usage?.cache_creation_input_tokens || 0,
			cache_read_input_tokens: (openaiResponse.usage?.prompt_tokens_details?.cached_tokens ?? openaiResponse.usage?.cache_read_input_tokens ?? 0)
		}
	};

	if (message.reasoning_content) {
		anthropicResponse.content.push({
			type: 'thinking',
			thinking: message.reasoning_content
		});
	}

	if (message.content) {
		anthropicResponse.content.push({
			type: 'text',
			text: message.content
		});
	}

	if (message.tool_calls && Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
			let inputObj = {};
			try {
				const args = tc.function?.arguments;
				inputObj = typeof args === 'string' ? JSON.parse(args) : (args || {});
			} catch (_) {
				inputObj = {};
			}
			anthropicResponse.content.push({
				type: 'tool_use',
				id: tc.id,
				name: tc.function?.name || '',
				input: inputObj
			});
		}
	}

	const finishReason = choice.finish_reason;
	if (finishReason === 'stop') {
		// OpenAI finish_reason='stop' 不区分自然结束/命中停词；检查 content 结尾推断 stop_sequence
		let hitStop = null;
		if (Array.isArray(stopSequences) && typeof message.content === 'string') {
			for (const s of stopSequences) {
				if (s && message.content.endsWith(s)) { hitStop = s; break; }
			}
			// 未匹配到但只传了单个 stop_sequence：CF Workers AI 截断 stop 串（不含在 content 中），合理判定命中
			if (hitStop === null && stopSequences.length === 1 && stopSequences[0]) {
				hitStop = stopSequences[0];
			}
		}
		if (hitStop !== null) {
			anthropicResponse.stop_reason = 'stop_sequence';
			anthropicResponse.stop_sequence = hitStop;
		} else {
			anthropicResponse.stop_reason = 'end_turn';
		}
	} else if (finishReason === 'tool_calls') {
		anthropicResponse.stop_reason = 'tool_use';
	} else if (finishReason === 'length') {
		anthropicResponse.stop_reason = 'max_tokens';
	} else {
		anthropicResponse.stop_reason = finishReason || 'end_turn';
	}

	return anthropicResponse;
}

// ===== handleMessages =====
async function handleMessages(request, env, ctx) {
	const requestStartTime = Date.now();
	const anthropicBody = await safeJsonBody(request);
	if (!anthropicBody) return anthropicError('Invalid or missing JSON body.');

	if (!anthropicBody.messages || !Array.isArray(anthropicBody.messages)) {
		return anthropicError('messages field is required and must be an array.');
	}

	const model = anthropicBody.model;
	const { cfModel, isFallback, tokens } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model}" not found in mapping, fell back to ${cfModel}`) : null;
	if (isFallback && model && (env.STRICT_MODEL_MATCH || '').toLowerCase() === 'true') {
		return anthropicError(`Model '${model}' not found`, 404);
	}

	const openaiBody = convertAnthropicToOpenAI(anthropicBody);
	openaiBody.model = cfModel;

	const stream = !!anthropicBody.stream;
	if (stream) {
		openaiBody.stream_options = { include_usage: true };
	}

	// Token 上限 clamp
	if (tokens) {
		if (openaiBody.max_tokens && openaiBody.max_tokens > tokens) {
			openaiBody.max_tokens = tokens;
		}
		if (openaiBody.max_completion_tokens && openaiBody.max_completion_tokens > tokens) {
			openaiBody.max_completion_tokens = tokens;
		}
	}

	// P3: 过大闸检查（闸值优先级：env 显式配置 > 模型自身 tokens > 默认 20 万）
	if (shouldRejectOversize(openaiBody, env, tokens)) {
		const wan = Math.max(1, Math.round(oversizeTokenLimit(env, tokens) / 10000));
		return anthropicError(`上下文过长：一轮最多发 ${wan} 万 token。请在客户端压缩对话或开新会话后重试。`, 400);
	}

	// P2: 模型断供闩 → 跳过重试直接返回
	if (modelDown(env, cfModel)) {
		const fe = friendlyError(new Error('4006: Service temporarily at capacity'));
		return anthropicError(fe.message, fe.status);
	}

	const result = await callBindingChat(cfModel, openaiBody, env, stream);

	if (!result.success) {
		const fe = friendlyError(result.error);
		const anthropicErr = {
			type: 'error',
			error: { type: fe.type, message: fe.message }
		};
		return new Response(JSON.stringify(anthropicErr), {
			status: fe.status || 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (stream) {
		return streamResponse(
			anthropicStreamTransform(result.stream, model, anthropicBody.messages, env, ctx, requestStartTime),
			fallbackWarning
		);
	}
	const openaiResponse = result.data;
	accumulateFromUsage(env, ctx, openaiResponse.usage, requestStartTime, model);
	return jsonResponse(convertOpenAIToAnthropic(openaiResponse, model, anthropicBody.stop_sequences), fallbackWarning);
}

// ===== Anthropic SSE 流式转换：OpenAI SSE → Anthropic SSE =====
function anthropicStreamTransform(upstreamBody, modelName, originalMessages, env, ctx, requestStartTime) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let messageId = `msg_${crypto.randomUUID()}`;
	let contentBlockIndex = -1;
	let currentToolCallId = null;
	let currentToolName = null;
	let currentToolArgs = '';
	let streamStarted = false;
	let blockStopSent = false;
	let finalEventSent = false;
	let thinkingBlockActive = false;
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;

	let enqueuedAny = false;
	let pingInterval = null;

	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(': ping\n\n'));
			pingInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch (_) { /* controller 已关闭 */ }
			}, 10000);
		},
		async pull(controller) {
			enqueuedAny = false;
			const originalEnqueue = controller.enqueue.bind(controller);
			controller.enqueue = (chunk) => {
				enqueuedAny = true;
				originalEnqueue(chunk);
			};

			try {
				while (true) {
					const result = await readWithTimeout(reader, 120000);
					if (result.done) {
						if (buffer.trim()) {
							buffer = processLines(buffer, controller);
							if (buffer.trim()) {
								controller.enqueue(encoder.encode(`${buffer.trim()}\n\n`));
							}
						}
						if (!finalEventSent) {
							sendFinalEvent(controller);
						}
						controller.close();
						if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
						break;
					}

					buffer += decoder.decode(result.value, { stream: true });
					buffer = processLines(buffer, controller);

					if (buffer.indexOf('\n') === -1) {
						if (enqueuedAny) {
							break;
						}
					}
				}
			} catch (e) {
				console.error(`anthropicStreamTransform upstream error: ${e?.message || e}`);
				try {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					if (!finalEventSent) {
						sendFinalEvent(controller);
					}
				} catch (e2) { console.error('anthropicStreamTransform secondary error:', e2?.message || e2); }
				if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
				try { controller.close(); } catch (_) { }
			}
		},
		cancel() {
			if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
			return reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') {
					sendFinalEvent(controller);
					continue;
				}

				try {
				let chunk = JSON.parse(dataStr);
				// 流式格式归一化：CF Binding 流式返回原生格式 {response, usage, tool_calls}，
				// 转成 OpenAI streaming chunk {choices: [{delta: {content}, finish_reason: null}]}
				if (!chunk.choices && chunk.response !== undefined) {
					const originalUsage = chunk.usage;
					chunk = {
						id: chunk.id || `chatcmpl-${crypto.randomUUID()}`,
						object: 'chat.completion.chunk',
						created: chunk.created || Math.floor(Date.now() / 1000),
						model: modelName,
						choices: [{ index: 0, delta: { content: chunk.response }, finish_reason: null }]
					};
					if (originalUsage) chunk.usage = originalUsage;
				}

					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta || {};

					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens || 0;
						outputTokens = chunk.usage.completion_tokens || 0;
						reasoningTokens = chunk.usage.reasoning_tokens || 0;
						cacheReadTokens = (chunk.usage.prompt_tokens_details?.cached_tokens || chunk.usage.cache_read_tokens || 0);
						cacheWriteTokens = chunk.usage.cache_write_tokens || 0;
					}

					if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
						if (!streamStarted) {
							sendMessageStart(controller);
							streamStarted = true;
						}

						for (const tc of delta.tool_calls) {
							if (tc.id) {
								if (currentToolCallId) {
									sendContentBlockStop(controller);
									blockStopSent = true;
								}
								currentToolCallId = tc.id;
								currentToolName = tc.function?.name || '';
								currentToolArgs = '';
								contentBlockIndex++;
								blockStopSent = false;

								sendContentBlockStart(controller, 'tool_use');
							}

							if (tc.function?.arguments) {
								currentToolArgs += tc.function.arguments;
								sendToolUseDelta(controller, tc.function.arguments);
							}
						}
					} else if (delta.reasoning_content) {
						if (!streamStarted) {
							sendMessageStart(controller);
							streamStarted = true;
						}
						if (!thinkingBlockActive) {
							contentBlockIndex++;
							sendContentBlockStart(controller, 'thinking');
							thinkingBlockActive = true;
							blockStopSent = false;
						}
						sendThinkingDelta(controller, delta.reasoning_content);
					} else if (delta.content) {
						if (!streamStarted) {
							sendMessageStart(controller);
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							streamStarted = true;
							blockStopSent = false;
						}

						if (thinkingBlockActive) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							thinkingBlockActive = false;
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							blockStopSent = false;
						}

						if (currentToolCallId) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							currentToolCallId = null;
							currentToolName = null;
							currentToolArgs = '';

							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							blockStopSent = false;
						}

						sendTextDelta(controller, delta.content);
					}

					if (choice.finish_reason) {
						if (thinkingBlockActive) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							thinkingBlockActive = false;
						}
						if (currentToolCallId && currentToolArgs) {
							sendToolUseFinalInput(controller);
						}
					}
				} catch (e) { console.error('Anthropic processLines error:', e?.message || e); }
			}
		}
		return remaining;
	}

	function sendMessageStart(controller) {
		const event = {
			type: 'message_start',
			message: {
				id: messageId,
				type: 'message',
				role: 'assistant',
				content: [],
				model: modelName,
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: inputTokens,
					output_tokens: outputTokens,
					cache_creation_input_tokens: cacheWriteTokens || 0,
					cache_read_input_tokens: cacheReadTokens || 0,
				}
			}
		};
		controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendContentBlockStart(controller, blockType) {
		const event = {
			type: 'content_block_start',
			index: contentBlockIndex,
			content_block: blockType === 'tool_use'
				? { type: 'tool_use', id: currentToolCallId, name: currentToolName, input: {} }
				: blockType === 'thinking'
					? { type: 'thinking', thinking: '' }
					: { type: 'text', text: '' }
		};
		controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendTextDelta(controller, text) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'text_delta', text }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendThinkingDelta(controller, thinking) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'thinking_delta', thinking }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseDelta(controller, argsDelta) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'input_json_delta', partial_json: argsDelta }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseFinalInput(controller) {
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
		blockStopSent = true;
	}

	function sendContentBlockStop(controller) {
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
	}

	function sendFinalEvent(controller) {
		if (finalEventSent) return;
		if (!streamStarted) {
			sendMessageStart(controller);
			contentBlockIndex++;
			sendContentBlockStart(controller, 'text');
		}
		if (!blockStopSent) {
			try { sendContentBlockStop(controller); } catch (_) { /* 忽略 enqueue 异常 */ }
		}
		blockStopSent = true;

		let stopReason = 'end_turn';
		if (currentToolCallId) {
			stopReason = 'tool_use';
		}

		const event = {
			type: 'message_delta',
			delta: {
				stop_reason: stopReason,
				stop_sequence: null
			},
			usage: { output_tokens: outputTokens || 0 }
		};
		try { controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`)); } catch (_) { /* 忽略 */ }

		try { controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
			type: 'message_stop'
		})}\n\n`)); } catch (_) { /* 忽略 */ }
		finalEventSent = true;

		if (env && ctx && (inputTokens > 0 || outputTokens > 0)) {
			accumulateTokens(env, ctx, {
				input: inputTokens,
				output: outputTokens,
				reasoning: reasoningTokens,
				cacheRead: cacheReadTokens,
				cacheWrite: cacheWriteTokens,
				durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
				model,
			});
		}
	}
}

// ===== OpenAI Responses API（/v1/responses）→ Chat Completions 格式转换 =====
// 新版 codex-cli 只支持 Responses 协议（wire_api = "responses"），
// 网关把 Responses 请求转成 Chat Completions 调上游，再把响应转回 Responses
function convertResponsesToOpenAI(responsesBody) {
	const openaiBody = {};

	if (responsesBody.max_output_tokens !== undefined) openaiBody.max_tokens = responsesBody.max_output_tokens;
	if (responsesBody.temperature !== undefined) openaiBody.temperature = responsesBody.temperature;
	if (responsesBody.top_p !== undefined) openaiBody.top_p = responsesBody.top_p;
	if (responsesBody.stop !== undefined) openaiBody.stop = responsesBody.stop;
	if (responsesBody.stream !== undefined) openaiBody.stream = responsesBody.stream;
	if (responsesBody.parallel_tool_calls !== undefined) openaiBody.parallel_tool_calls = responsesBody.parallel_tool_calls;

	// reasoning.effort（low/medium/high）→ chat 的 reasoning_effort
	if (responsesBody.reasoning?.effort) openaiBody.reasoning_effort = responsesBody.reasoning.effort;

	// text.format 的 json_schema（结构化输出）→ response_format，其余 text 配置忽略
	const textFormat = responsesBody.text?.format;
	if (textFormat?.type === 'json_schema' && textFormat.schema) {
		const jsonSchema = {
			name: textFormat.name || 'response',
			schema: textFormat.schema
		};
		if (textFormat.strict !== undefined) jsonSchema.strict = textFormat.strict;
		openaiBody.response_format = { type: 'json_schema', json_schema: jsonSchema };
	}

	// tool_choice：字符串透传；对象形式 {type:'function',name} → 嵌套 {type:'function',function:{name}}
	if (responsesBody.tool_choice !== undefined) {
		const tc = responsesBody.tool_choice;
		if (typeof tc === 'string') {
			openaiBody.tool_choice = tc;
		} else if (tc && tc.type === 'function' && tc.name) {
			openaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
		} else {
			openaiBody.tool_choice = tc;
		}
	}

	const openaiMessages = [];

	// instructions（系统提示词）→ 开头的 system 消息
	if (typeof responsesBody.instructions === 'string' && responsesBody.instructions) {
		openaiMessages.push({ role: 'system', content: responsesBody.instructions });
	}

	// input：字符串 → 单条 user 消息；数组 → 逐 item 转换
	if (typeof responsesBody.input === 'string') {
		openaiMessages.push({ role: 'user', content: responsesBody.input });
	} else if (Array.isArray(responsesBody.input)) {
		for (const item of responsesBody.input) {
			if (!item || typeof item !== 'object') continue;

			if (item.type === 'message') {
				// content: [{type:'input_text'|'output_text', text}] → 文本拼接为字符串（input_image 暂不支持，拼占位符）
				const role = item.role === 'assistant' ? 'assistant' : 'user';
				let textContent = '';
				if (typeof item.content === 'string') {
					textContent = item.content;
				} else if (Array.isArray(item.content)) {
					for (const part of item.content) {
						if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && part.text) {
							textContent += part.text;
						} else if (part.type === 'input_image') {
							textContent += '[to be added]';
						}
					}
				}
				openaiMessages.push({ role, content: textContent });
			} else if (item.type === 'function_call') {
				// chat 协议要求 tool 消息前紧跟带 tool_calls 的 assistant 消息，
				// 连续多个 function_call 合并进同一条 assistant 消息的 tool_calls 数组
				const toolCall = {
					id: item.call_id,
					type: 'function',
					function: { name: item.name, arguments: item.arguments || '{}' }
				};
				const lastMsg = openaiMessages[openaiMessages.length - 1];
				if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.tool_calls)) {
					lastMsg.tool_calls.push(toolCall);
				} else {
					openaiMessages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
				}
			} else if (item.type === 'function_call_output') {
				// output 可能是字符串或 [{type:'output_text', text}] 数组，统一转字符串
				let outputContent = '';
				if (typeof item.output === 'string') {
					outputContent = item.output;
				} else if (Array.isArray(item.output)) {
					for (const part of item.output) {
						if (part && part.text) outputContent += part.text;
					}
				} else if (item.output && typeof item.output === 'object') {
					outputContent = JSON.stringify(item.output);
				}
				openaiMessages.push({ role: 'tool', tool_call_id: item.call_id, content: outputContent });
			}
			// type === 'reasoning'（encrypted_content/summary）：store=false 无状态思考，跳过忽略
		}
	}

	// 首条非 system 消息是 assistant 时插一条占位 user（部分上游要求以 user 开头）
	const firstNonSystemMsg = openaiMessages.find(m => m.role !== 'system');
	if (firstNonSystemMsg && firstNonSystemMsg.role === 'assistant') {
		const systemCount = openaiMessages.filter(m => m.role === 'system').length;
		openaiMessages.splice(systemCount, 0, { role: 'user', content: ' ' });
	}

	openaiBody.messages = openaiMessages;

	// tools：Responses 扁平格式 → chat 嵌套格式（无 parameters 时给空 object schema）
	if (Array.isArray(responsesBody.tools)) {
		openaiBody.tools = responsesBody.tools
			.filter(t => t && t.type === 'function')
			.map(t => ({
				type: 'function',
				function: {
					name: t.name,
					description: t.description || '',
					parameters: t.parameters || { type: 'object', properties: {} }
				}
			}));
	}

	return openaiBody;
}

// ===== OpenAI Chat Completion 响应 → Responses 格式转换 =====
function convertOpenAIToResponses(openaiResponse, originalModel, requestData) {
	const choice = openaiResponse.choices?.[0] || {};
	const message = choice.message || {};
	const usage = openaiResponse.usage || {};

	const output = [];

	// 思考内容 → reasoning item（codex 容忍 summary 为空，这里放思考全文）
	if (message.reasoning_content) {
		output.push({
			type: 'reasoning',
			id: `rs_${crypto.randomUUID()}`,
			summary: [{ type: 'summary_text', text: message.reasoning_content }]
		});
	}

	// 正文 → message item
	if (message.content) {
		output.push({
			type: 'message',
			id: `msg_${crypto.randomUUID()}`,
			role: 'assistant',
			status: 'completed',
			content: [{ type: 'output_text', text: message.content, annotations: [] }]
		});
	}

	// 工具调用 → function_call item
	if (Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
			output.push({
				type: 'function_call',
				id: `fc_${crypto.randomUUID()}`,
				call_id: tc.id,
				name: tc.function?.name || '',
				arguments: tc.function?.arguments || '{}',
				status: 'completed'
			});
		}
	}

	const incomplete = choice.finish_reason === 'length';

	// codex 主要读 status/output/usage/id/model/error
	return {
		id: `resp_${crypto.randomUUID()}`,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		status: incomplete ? 'incomplete' : 'completed',
		model: originalModel,
		output,
		usage: {
			input_tokens: usage.prompt_tokens || 0,
			input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0 },
			output_tokens: usage.completion_tokens || 0,
			output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens || 0 },
			total_tokens: usage.total_tokens || 0
		},
		error: null,
		incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
		instructions: requestData?.instructions ?? null,
		parallel_tool_calls: requestData?.parallel_tool_calls ?? null,
		temperature: requestData?.temperature ?? null,
		top_p: requestData?.top_p ?? null,
		tool_choice: requestData?.tool_choice ?? null,
		tools: requestData?.tools ?? null
	};
}

// ===== handleResponses（/v1/responses，OpenAI Responses 协议入口） =====
async function handleResponses(request, env, ctx) {
	const requestStartTime = Date.now();
	const responsesBody = await safeJsonBody(request);
	if (!responsesBody) return jsonError("Invalid or missing JSON body", 400, "invalid_request_error");

	if (responsesBody.input === undefined) {
		return jsonError("input field is required", 400, "invalid_request_error");
	}

	const model = responsesBody.model;
	const { cfModel, isFallback, tokens } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model}" not found in mapping, fell back to ${cfModel}`) : null;
	if (isFallback && model && (env.STRICT_MODEL_MATCH || '').toLowerCase() === 'true') {
		return jsonError(`Model '${model}' not found`, 404, "invalid_request_error", "model_not_found");
	}

	const openaiBody = convertResponsesToOpenAI(responsesBody);
	openaiBody.model = cfModel;

	const stream = !!responsesBody.stream;
	if (stream) {
		openaiBody.stream_options = { include_usage: true };
	}

	// Token 上限 clamp
	if (tokens) {
		if (openaiBody.max_tokens && openaiBody.max_tokens > tokens) {
			openaiBody.max_tokens = tokens;
		}
		if (openaiBody.max_completion_tokens && openaiBody.max_completion_tokens > tokens) {
			openaiBody.max_completion_tokens = tokens;
		}
	}

	// P3: 过大闸检查（闸值优先级：env 显式配置 > 模型自身 tokens > 默认 20 万）
	if (shouldRejectOversize(openaiBody, env, tokens)) {
		const wan = Math.max(1, Math.round(oversizeTokenLimit(env, tokens) / 10000));
		return jsonError(`上下文过长：一轮最多发 ${wan} 万 token。请在客户端压缩对话或开新会话后重试。`, 400, 'invalid_request_error');
	}

	// P2: 模型断供闩 → 跳过重试直接返回
	if (modelDown(env, cfModel)) {
		const fe = friendlyError(new Error('4006: Service temporarily at capacity'));
		return jsonError(fe.message, fe.status, fe.type);
	}

	const result = await callBindingChat(cfModel, openaiBody, env, stream);

	if (!result.success) {
		const fe = friendlyError(result.error);
		return jsonError(fe.message, fe.status || 502, fe.type);
	}

	if (stream) {
		return streamResponse(
			responsesStreamTransform(result.stream, model, env, ctx, requestStartTime),
			fallbackWarning
		);
	}
	const openaiResponse = result.data;
	accumulateFromUsage(env, ctx, openaiResponse.usage, requestStartTime, model);
	return jsonResponse(convertOpenAIToResponses(openaiResponse, model, {
		instructions: responsesBody.instructions,
		parallel_tool_calls: responsesBody.parallel_tool_calls,
		temperature: responsesBody.temperature,
		top_p: responsesBody.top_p,
		tool_choice: responsesBody.tool_choice,
		tools: responsesBody.tools
	}), fallbackWarning);
}

// ===== Responses SSE 流式转换：OpenAI Chat SSE → Responses SSE =====
// 事件序列：response.created → output_item/content_part/output_text/reasoning_summary/function_call_arguments
// 系列增量 → flush 所有未闭合 item → response.completed（含完整 output 数组 + usage）
function responsesStreamTransform(upstreamBody, originalModel, env, ctx, requestStartTime) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let pingInterval = null;

	const responseId = `resp_${crypto.randomUUID()}`;
	const createdAt = Math.floor(Date.now() / 1000);
	let finalEventSent = false;
	let finishReason = null;
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheReadTokens = 0;
	let totalTokens = 0;

	// output item 状态：message/reasoning 各至多一个未闭合 item，tool_calls 按 index 分组
	let nextOutputIndex = 0; // 给每个产出 item 分配递增 output_index（0,1,2...），item 开始到结束保持一致
	let msgItem = null;       // {id, outputIndex, text}
	let reasoningItem = null; // {id, outputIndex, text}
	const toolItems = new Map(); // delta.tool_calls 的 index → {id, callId, outputIndex, name, args}
	const finalOutput = [];     // 已闭合 item 全量数组（response.completed 用）

	let enqueuedAny = false;

	return new ReadableStream({
		start(controller) {
			// 流开始即发 response.created（codex-cli 等客户端等待此事件后才开始消费增量）
			controller.enqueue(encoder.encode(sseEvent('response.created', {
				type: 'response.created',
				response: {
					id: responseId,
					object: 'response',
					created_at: createdAt,
					status: 'in_progress',
					model: originalModel,
					output: []
				}
			})));
			// 定时 ping 保持连接（推理模型首 token 延迟可能较长）
			pingInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch (_) { /* controller 已关闭 */ }
			}, 10000);
		},
		async pull(controller) {
			enqueuedAny = false;
			const originalEnqueue = controller.enqueue.bind(controller);
			controller.enqueue = (chunk) => {
				enqueuedAny = true;
				originalEnqueue(chunk);
			};

			try {
				while (true) {
					const result = await readWithTimeout(reader, 120000);
					if (result.done) {
						if (buffer.trim()) {
							buffer = processLines(buffer, controller);
							// 流结束，剩余不完整行视为完整事件发送
							if (buffer.trim()) {
								controller.enqueue(encoder.encode(`${buffer.trim()}\n\n`));
							}
						}
						if (!finalEventSent) {
							sendFinalEvent(controller);
						}
						controller.close();
						if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
						break;
					}

					buffer += decoder.decode(result.value, { stream: true });
					buffer = processLines(buffer, controller);

					if (buffer.indexOf('\n') === -1) {
						if (enqueuedAny) {
							break;
						}
					}
				}
			} catch (e) {
				console.error(`responsesStreamTransform upstream error: ${e?.message || e}`);
				try {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					if (!finalEventSent) {
						sendFailedEvent(controller, e);
					}
				} catch (e2) { console.error('responsesStreamTransform secondary error:', e2?.message || e2); }
				if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
				try { controller.close(); } catch (_) { }
			}
		},
		cancel() {
			if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
			return reader.cancel();
		},
	});

	// SSE 事件格式：event 行 + data 行
	function sseEvent(eventType, payload) {
		return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
	}

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') {
					// 发送最终事件
					sendFinalEvent(controller);
					continue;
				}

				try {
				let chunk = JSON.parse(dataStr);
				// 流式格式归一化：CF Binding 流式返回原生格式 {response, usage, tool_calls}，
				// 转成 OpenAI streaming chunk {choices: [{delta: {content}, finish_reason: null}]}
				if (!chunk.choices && chunk.response !== undefined) {
					const originalUsage = chunk.usage;
					chunk = {
						id: chunk.id || `chatcmpl-${crypto.randomUUID()}`,
						object: 'chat.completion.chunk',
						created: chunk.created || Math.floor(Date.now() / 1000),
						model: originalModel,
						choices: [{ index: 0, delta: { content: chunk.response }, finish_reason: null }]
					};
					if (originalUsage) chunk.usage = originalUsage;
				}

				// usage 记录放在 choice 校验前：usage 尾块（choices 为空）也能累计
				if (chunk.usage) {
					inputTokens = chunk.usage.prompt_tokens || 0;
					outputTokens = chunk.usage.completion_tokens || 0;
					reasoningTokens = chunk.usage.reasoning_tokens || chunk.usage.completion_tokens_details?.reasoning_tokens || 0;
					cacheReadTokens = (chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.cache_read_tokens ?? 0);
					totalTokens = chunk.usage.total_tokens || 0;
				}

					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta || {};
					if (choice.finish_reason) finishReason = choice.finish_reason;

					if (delta.reasoning_content) {
						// 思考增量 → reasoning item 的 summary delta
						closeMessageItem(controller);
						if (!reasoningItem) {
							openReasoningItem(controller);
						}
						sendReasoningSummaryDelta(controller, delta.reasoning_content);
					}

					if (delta.content) {
						// 正文增量 → message item 的 output_text delta
						closeReasoningItem(controller);
						if (!msgItem) {
							openMessageItem(controller);
						}
						sendOutputTextDelta(controller, delta.content);
					}

					if (Array.isArray(delta.tool_calls)) {
						// 工具调用增量 → function_call item 的 arguments delta（id/name 在首块出现，arguments 增量拼接）
						closeMessageItem(controller);
						closeReasoningItem(controller);
						for (const tc of delta.tool_calls) {
							const tcIndex = tc.index ?? 0;
							let item = toolItems.get(tcIndex);
							if (!item) {
								item = openToolItem(controller, tcIndex, tc);
							} else if (tc.function?.name && !item.name) {
								// 函数名可能在后续块补齐
								item.name = tc.function.name;
							}
							if (tc.function?.arguments) {
								item.args += tc.function.arguments;
								sendToolArgsDelta(controller, item, tc.function.arguments);
							}
						}
					}

					if (choice.finish_reason) {
						// 上游可能不发各 item 的结束信号，finish_reason 时统一 flush 所有未闭合 item
						flushOpenItems(controller);
					}
				} catch (e) { console.error('Responses processLines error:', e?.message || e); }
			}
		}
		return remaining;
	}

	// 开 message item：output_item.added + content_part.added
	function openMessageItem(controller) {
		const id = `msg_${crypto.randomUUID()}`;
		const outputIndex = nextOutputIndex++;
		msgItem = { id, outputIndex, text: '' };
		controller.enqueue(encoder.encode(sseEvent('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] }
		})));
		controller.enqueue(encoder.encode(sseEvent('response.content_part.added', {
			type: 'response.content_part.added',
			item_id: id,
			output_index: outputIndex,
			content_index: 0,
			part: { type: 'output_text', text: '', annotations: [] }
		})));
	}

	// 闭 message item：output_text.done（text=累计全文）+ content_part.done + output_item.done
	function closeMessageItem(controller) {
		if (!msgItem) return;
		const { id, outputIndex, text } = msgItem;
		controller.enqueue(encoder.encode(sseEvent('response.output_text.done', {
			type: 'response.output_text.done',
			item_id: id,
			output_index: outputIndex,
			content_index: 0,
			text
		})));
		controller.enqueue(encoder.encode(sseEvent('response.content_part.done', {
			type: 'response.content_part.done',
			item_id: id,
			output_index: outputIndex,
			content_index: 0,
			part: { type: 'output_text', text, annotations: [] }
		})));
		const item = { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
		controller.enqueue(encoder.encode(sseEvent('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: outputIndex,
			item
		})));
		finalOutput.push(item);
		msgItem = null;
	}

	// 开 reasoning item：output_item.added + reasoning_summary_part.added
	function openReasoningItem(controller) {
		const id = `rs_${crypto.randomUUID()}`;
		const outputIndex = nextOutputIndex++;
		reasoningItem = { id, outputIndex, text: '' };
		controller.enqueue(encoder.encode(sseEvent('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: { type: 'reasoning', id, summary: [] }
		})));
		controller.enqueue(encoder.encode(sseEvent('response.reasoning_summary_part.added', {
			type: 'response.reasoning_summary_part.added',
			item_id: id,
			output_index: outputIndex,
			summary_index: 0,
			part: { type: 'summary_text', text: '' }
		})));
	}

	// 闭 reasoning item：reasoning_summary_text/part.done + output_item.done（summary 含累计思考全文）
	function closeReasoningItem(controller) {
		if (!reasoningItem) return;
		const { id, outputIndex, text } = reasoningItem;
		controller.enqueue(encoder.encode(sseEvent('response.reasoning_summary_text.done', {
			type: 'response.reasoning_summary_text.done',
			item_id: id,
			output_index: outputIndex,
			summary_index: 0,
			text
		})));
		controller.enqueue(encoder.encode(sseEvent('response.reasoning_summary_part.done', {
			type: 'response.reasoning_summary_part.done',
			item_id: id,
			output_index: outputIndex,
			summary_index: 0,
			part: { type: 'summary_text', text }
		})));
		const item = { type: 'reasoning', id, summary: [{ type: 'summary_text', text }] };
		controller.enqueue(encoder.encode(sseEvent('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: outputIndex,
			item
		})));
		finalOutput.push(item);
		reasoningItem = null;
	}

	function sendReasoningSummaryDelta(controller, delta) {
		reasoningItem.text += delta;
		controller.enqueue(encoder.encode(sseEvent('response.reasoning_summary_text.delta', {
			type: 'response.reasoning_summary_text.delta',
			item_id: reasoningItem.id,
			output_index: reasoningItem.outputIndex,
			summary_index: 0,
			delta
		})));
	}

	function sendOutputTextDelta(controller, delta) {
		msgItem.text += delta;
		controller.enqueue(encoder.encode(sseEvent('response.output_text.delta', {
			type: 'response.output_text.delta',
			item_id: msgItem.id,
			output_index: msgItem.outputIndex,
			content_index: 0,
			delta
		})));
	}

	// 开 function_call item：output_item.added（arguments 空、status in_progress）
	function openToolItem(controller, tcIndex, tc) {
		const id = `fc_${crypto.randomUUID()}`;
		const outputIndex = nextOutputIndex++;
		const item = { id, callId: tc.id || '', outputIndex, name: tc.function?.name || '', args: '' };
		toolItems.set(tcIndex, item);
		controller.enqueue(encoder.encode(sseEvent('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: { type: 'function_call', id, call_id: item.callId, name: item.name, arguments: '', status: 'in_progress' }
		})));
		return item;
	}

	function sendToolArgsDelta(controller, item, delta) {
		controller.enqueue(encoder.encode(sseEvent('response.function_call_arguments.delta', {
			type: 'response.function_call_arguments.delta',
			item_id: item.id,
			output_index: item.outputIndex,
			delta
		})));
	}

	// 闭 function_call item：function_call_arguments.done（arguments=累计全串）+ output_item.done
	function closeToolItem(controller, item) {
		controller.enqueue(encoder.encode(sseEvent('response.function_call_arguments.done', {
			type: 'response.function_call_arguments.done',
			item_id: item.id,
			output_index: item.outputIndex,
			arguments: item.args
		})));
		const doneItem = { type: 'function_call', id: item.id, call_id: item.callId, name: item.name, arguments: item.args, status: 'completed' };
		controller.enqueue(encoder.encode(sseEvent('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: item.outputIndex,
			item: doneItem
		})));
		finalOutput.push(doneItem);
	}

	// flush 所有未闭合 item（finish_reason 或流结束时调用；上游可能不发 function_call 的结束信号）
	function flushOpenItems(controller) {
		closeReasoningItem(controller);
		closeMessageItem(controller);
		for (const item of toolItems.values()) {
			closeToolItem(controller, item);
		}
		toolItems.clear();
	}

	function buildResponseObject(status) {
		return {
			id: responseId,
			object: 'response',
			created_at: createdAt,
			status,
			model: originalModel,
			output: finalOutput,
			usage: {
				input_tokens: inputTokens,
				input_tokens_details: { cached_tokens: cacheReadTokens },
				output_tokens: outputTokens,
				output_tokens_details: { reasoning_tokens: reasoningTokens },
				total_tokens: totalTokens || (inputTokens + outputTokens)
			},
			error: null,
			incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
			instructions: null,
			parallel_tool_calls: null,
			temperature: null,
			top_p: null,
			tool_choice: null,
			tools: null
		};
	}

	function sendFinalEvent(controller) {
		if (finalEventSent) return;
		// flush 所有未闭合 item（完整数据用累计值构造）
		flushOpenItems(controller);

		// 上游未产生任何内容（空响应）→ 兜底发一个空 message item
		if (finalOutput.length === 0) {
			const id = `msg_${crypto.randomUUID()}`;
			const outputIndex = nextOutputIndex++;
			controller.enqueue(encoder.encode(sseEvent('response.output_item.added', {
				type: 'response.output_item.added',
				output_index: outputIndex,
				item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] }
			})));
			controller.enqueue(encoder.encode(sseEvent('response.content_part.added', {
				type: 'response.content_part.added',
				item_id: id,
				output_index: outputIndex,
				content_index: 0,
				part: { type: 'output_text', text: '', annotations: [] }
			})));
			controller.enqueue(encoder.encode(sseEvent('response.content_part.done', {
				type: 'response.content_part.done',
				item_id: id,
				output_index: outputIndex,
				content_index: 0,
				part: { type: 'output_text', text: '', annotations: [] }
			})));
			const emptyItem = { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] };
			controller.enqueue(encoder.encode(sseEvent('response.output_item.done', {
				type: 'response.output_item.done',
				output_index: outputIndex,
				item: emptyItem
			})));
			finalOutput.push(emptyItem);
		}

		const status = finishReason === 'length' ? 'incomplete' : 'completed';
		try { controller.enqueue(encoder.encode(sseEvent('response.completed', {
			type: 'response.completed',
			response: buildResponseObject(status)
		}))); } catch (_) { /* 忽略 enqueue 异常 */ }
		finalEventSent = true;

		// 流结束时累加 token 统计
		if (env && ctx && (inputTokens > 0 || outputTokens > 0)) {
			accumulateTokens(env, ctx, {
				input: inputTokens,
				output: outputTokens,
				reasoning: reasoningTokens,
				cacheRead: cacheReadTokens,
				cacheWrite: 0,
				durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0,
				model,
			});
		}
	}

	// 上游异常兜底：尽力发 response.failed 后关闭流
	function sendFailedEvent(controller, e) {
		finalEventSent = true;
		const response = buildResponseObject('failed');
		response.error = { code: 'server_error', message: e?.message || String(e) };
		try { controller.enqueue(encoder.encode(sseEvent('response.failed', {
			type: 'response.failed',
			response
		}))); } catch (_) { /* 忽略 enqueue 异常 */ }
	}
}

// ===== handleEmbeddings - 使用 AI Binding =====
async function handleEmbeddings(request, env, ctx) {
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Invalid or missing JSON body", 400, "invalid_request_error");

	const requestStartTime = Date.now();

	const { model, input } = body;
	if (!input) {
		return jsonError("input is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback, tokens } = await resolveModelName(model, env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model}" not found in mapping, fell back to ${cfModel}`) : null;
	const textArray = Array.isArray(input) ? input : [input];

	try {
		const result = await env.AI.run(cfModel, { text: textArray }, aiRunOptions(env, { signal: AbortSignal.timeout(120000) }));
		// AI Binding 返回格式: { data: [[...embeddings]] } 或直接是 embedding 数组
		let data;
		if (result.data && Array.isArray(result.data)) {
			data = result.data;
		} else if (Array.isArray(result)) {
			data = result;
		} else {
			data = [result];
		}

		const embeddings = data.map((emb, index) => ({
			object: "embedding", index, embedding: emb
		}));

		const response = {
			object: "list", data: embeddings, model,
			usage: {
				prompt_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 3), 0),
				total_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 3), 0)
			}
		};

		if (ctx) {
			accumulateTokens(env, ctx, { input: response.usage.prompt_tokens, durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0, model });
		}

		const embHeaders = { 'Content-Type': 'application/json' };
		if (fallbackWarning) embHeaders['X-Model-Fallback-Warning'] = fallbackWarning;
		return new Response(JSON.stringify(response), { headers: embHeaders });
	} catch (e) {
		const fe = friendlyError(e);
		return jsonError(fe.message, fe.status || 502, fe.type);
	}
}

// ===== handleImageGenerations - 使用 AI Binding =====
async function handleImageGenerations(request, env, ctx) {
	const requestStartTime = Date.now();
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Invalid or missing JSON body", 400, "invalid_request_error");

	const { model, prompt, response_format } = body;
	if (!prompt) {
		return jsonError("prompt is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback, tokens } = await resolveModelName(model || 'flux-1-schnell', env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model || 'flux-1-schnell'}" not found in mapping, fell back to ${cfModel}`) : null;

	let width = 1024, height = 1024;
	if (body.size && typeof body.size === 'string') {
		const parts = body.size.split('x');
		if (parts.length === 2) {
			// P3-4: 限制 width/height 范围 [64, 2048]，避免恶意超大尺寸浪费推理配额
			width = Math.min(Math.max(parseInt(parts[0]) || 1024, 64), 2048);
			height = Math.min(Math.max(parseInt(parts[1]) || 1024, 64), 2048);
		}
	}

	try {
		// flux 系列 schema 仅接受 prompt（多传 width/height/num_steps 会 400 Additional properties not allowed）
		const cfPayload = cfModel.includes('flux') ? { prompt } : { prompt, width, height };

		const result = await env.AI.run(cfModel, cfPayload, aiRunOptions(env, { signal: AbortSignal.timeout(120000) }));

		// AI Binding 返回格式: flux 系列 JSON { image: "base64string" }；sdxl 等二进制模型返回 ReadableStream（官方文档）
		let rawImage;
		if (result instanceof Response) {
			rawImage = new Uint8Array(await result.arrayBuffer());
		} else if (result instanceof ReadableStream) {
			rawImage = new Uint8Array(await new Response(result).arrayBuffer());
		} else {
			rawImage = result.image || result;
		}
		let base64Str;
		if (typeof rawImage === 'string') {
			base64Str = rawImage;
		} else {
			const bytes = new Uint8Array(rawImage);
			let binary = '';
			const chunkSize = 8192;
			for (let i = 0; i < bytes.length; i += chunkSize) {
				binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
			}
			base64Str = btoa(binary);
		}

		const responseData = {
			created: Math.floor(Date.now() / 1000),
			data: [{
				[response_format === 'b64_json' ? 'b64_json' : 'url']:
					response_format === 'b64_json' ? base64Str : `data:image/png;base64,${base64Str}`
			}],
		};

		const imgHeaders = { 'Content-Type': 'application/json' };

		if (fallbackWarning) imgHeaders['X-Model-Fallback-Warning'] = fallbackWarning;
		if (ctx && prompt) {
			accumulateTokens(env, ctx, { input: Math.ceil(prompt.length / 3), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0, model });
		}
		return new Response(JSON.stringify(responseData), { headers: imgHeaders });
	} catch (e) {
		const fe = friendlyError(e);
		return jsonError(fe.message, fe.status || 502, fe.type);
	}
}

// ===== handleAudioTranscribe - 使用 AI Binding =====
async function handleAudioTranscribe(request, env, ctx, isTranslation) {
	const requestStartTime = Date.now();
	const contentType = request.headers.get('Content-Type') || '';
	if (!contentType.includes('multipart/form-data')) {
		return jsonError("Content-Type must be multipart/form-data", 400, "invalid_request_error");
	}

	// 流式检查请求体实际大小，避免 Content-Length 绕过
	// （chunked transfer-encoding 时 Content-Length 头缺失，parseInt('0')=0 绕过上限检查）
	// 不依赖 Content-Length 头，用 ReadableStream 累计实际字节数
	// 上限 8MB：Binding 需要 [...audioUint8] 数组展开，8MB→800万元素≈64MB内存；25MB 会超出 Workers 128MB 限制
	const MAX_AUDIO_SIZE = 8 * 1024 * 1024; // 8MB
	{
		const sizeReader = request.clone().body.getReader();
		let totalBytes = 0;
		try {
			while (true) {
				const { done, value } = await sizeReader.read();
				if (done) break;
				totalBytes += value.length;
			if (totalBytes > MAX_AUDIO_SIZE) {
				await sizeReader.cancel();
				return jsonError("File size exceeds 8MB limit", 413, "invalid_request_error");
			}
			}
		} finally {
			sizeReader.releaseLock();
		}
	}

	try {
		const formData = await request.formData();
		const audioFile = formData.get('file');
		const model = formData.get('model') || 'whisper';

		if (!audioFile) {
			return jsonError("file is required", 400, "invalid_request_error");
		}

		const { cfModel, isFallback, tokens } = await resolveModelName(model, env);
		const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model}" not found in mapping, fell back to ${cfModel}`) : null;

		const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
		const actualCfModel = cfModel.includes('whisper') ? cfModel : WHISPER_MODEL;
		const actualFallbackWarning = cfModel.includes('whisper') ? fallbackWarning : `Model "${model}" is not a whisper model, forced to ${WHISPER_MODEL}`;

		// 读取音频文件为 ArrayBuffer
		const audioArrayBuffer = await audioFile.arrayBuffer();
		const audioUint8 = new Uint8Array(audioArrayBuffer);

		// 二次校验实际音频大小（防御性，确保单文件不超限）
		if (audioUint8.length > MAX_AUDIO_SIZE) {
			return jsonError("File size exceeds 8MB limit", 413, "invalid_request_error");
		}

		// AI Binding 的 Whisper 要求 { audio: [...字节数组展开] }：传 Uint8Array 会报「未识别的上游错误」
		// （REST 实测：二进制 body 直传与 multipart 可用，JSON int 数组不可用；Binding 内部将数组编码为二进制流）
		// translations 加 task 参数
		const whisperInput = { audio: [...audioUint8] };
		if (isTranslation) whisperInput.task = 'translate';
		const result = await env.AI.run(actualCfModel, whisperInput, aiRunOptions(env, { signal: AbortSignal.timeout(120000) }));

		const text = result.text || '';

		if (ctx && text) {
			accumulateTokens(env, ctx, { output: Math.ceil(text.length / 3), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0, model });
		}

		const audioHeaders = { 'Content-Type': 'application/json' };
		if (actualFallbackWarning) audioHeaders['X-Model-Fallback-Warning'] = actualFallbackWarning;
		return new Response(JSON.stringify({ text }), { headers: audioHeaders });
	} catch (e) {
		const fe = friendlyError(e);
		return jsonError(fe.message, fe.status || 400, fe.type);
	}
}

// ===== handleAudioSpeech - 使用 AI Binding =====
async function handleAudioSpeech(request, env, ctx) {
	const body = await safeJsonBody(request);
	if (!body) return jsonError("Invalid or missing JSON body", 400, "invalid_request_error");

	const requestStartTime = Date.now();
	const { model, input, voice } = body;
	if (!input) {
		return jsonError("input is required", 400, "invalid_request_error");
	}

	const { cfModel, isFallback, tokens } = await resolveModelName(model || 'tts', env);
	const fallbackWarning = isFallback ? sanitizeHeaderValue(`Model "${model || 'tts'}" not found in mapping, fell back to ${cfModel}`) : null;

	// aura-2 的输入字段是 text 且 schema 严格（透传 OpenAI 的 voice/speed 等字段会 400）
	const cfPayload = cfModel.includes('aura') ? { text: input } : { prompt: input };

	try {
		const resp = await env.AI.run(cfModel, cfPayload, { returnRawResponse: true, signal: AbortSignal.timeout(600000) });
		if (!resp.ok) {
			const errText = await resp.text();
			let parsedErr;
			try { parsedErr = JSON.parse(errText); } catch (_) { parsedErr = { message: errText }; }
			const fe = friendlyError(new Error(parsedErr.message || errText));
			return jsonError(fe.message, fe.status || resp.status || 502, fe.type);
		}
		const audioBuffer = await resp.arrayBuffer();
		const contentType = resp.headers.get('Content-Type') || 'audio/wav';
		if (ctx) {
			accumulateTokens(env, ctx, { input: Math.ceil(input.length / 4), durationSec: requestStartTime ? (Date.now() - requestStartTime) / 1000 : 0, model });
		}
		return new Response(audioBuffer, {
			headers: {
				'Content-Type': contentType,
				...(fallbackWarning ? { 'X-Model-Fallback-Warning': fallbackWarning } : {}),
			}
		});
	} catch (e) {
		const fe = friendlyError(e);
		return jsonError(fe.message, fe.status || 502, fe.type);
	}
}

// ===== handleCountTokens =====
async function handleCountTokens(request, env) {
	const body = await safeJsonBody(request);
	if (!body) return anthropicError("Invalid or missing JSON body");

	if (!body.messages || !Array.isArray(body.messages)) {
		return anthropicError('messages field is required and must be an array.');
	}

	let totalChars = 0;

	if (body.system) {
		if (typeof body.system === 'string') {
			totalChars += body.system.length;
		} else if (Array.isArray(body.system)) {
			for (const block of body.system) {
				if (block.type === 'text' && block.text) totalChars += block.text.length;
			}
		}
	}

	for (const msg of body.messages) {
		if (typeof msg.content === 'string') {
			totalChars += msg.content.length;
		} else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text' && block.text) {
					totalChars += block.text.length;
				} else if (block.type === 'thinking' && block.thinking) {
					totalChars += block.thinking.length;
				} else if (block.type === 'image') {
					const source = block.source || {};
					if (source.data) {
						totalChars += Math.ceil(source.data.length / 4);
					}
				} else if (block.type === 'tool_use') {
					totalChars += JSON.stringify(block.input || {}).length;
				} else if (block.type === 'tool_result') {
					if (typeof block.content === 'string') {
						totalChars += block.content.length;
					} else if (Array.isArray(block.content)) {
						for (const c of block.content) {
							if (c.type === 'text' && c.text) totalChars += c.text.length;
						}
					}
				}
			}
		}
	}

	if (body.tools && Array.isArray(body.tools)) {
		for (const tool of body.tools) {
			totalChars += (tool.name || '').length;
			totalChars += (tool.description || '').length;
			totalChars += JSON.stringify(tool.input_schema || {}).length;
		}
	}

	const estimatedTokens = Math.ceil(totalChars / 3);

	return new Response(JSON.stringify({
		input_tokens: estimatedTokens,
	}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ===== passthroughStream - 透传 SSE 流 =====
function passthroughStream(upstreamBody, modelName, isCompletion, env, ctx, requestStartTime) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let streamUsage = null;
	let pingInterval = null;
	// 追踪上游是否已下发过 finish_reason
	let sawFinishReason = false;
	let lastChunkId = null;
	let lastChunkCreated = null;

	// 若上游未下发 finish_reason（Cloudflare 部分模型不返回），在 [DONE] 前补齐收尾块，
	// 避免 OpenAI 兼容客户端报 "Stream ended without finish_reason"。
	function ensureFinishReason(controller, reason) {
		if (sawFinishReason) return;
		const now = Math.floor(Date.now() / 1000);
		const base = {
			id: lastChunkId || `chatcmpl-${crypto.randomUUID()}`,
			created: lastChunkCreated || now,
			model: modelName
		};
		const chunk = isCompletion
			? { ...base, object: 'text_completion', choices: [{ index: 0, text: '', logprobs: null, finish_reason: reason }] }
			: { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }] };
		try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)); } catch (_) {}
		sawFinishReason = true;
	}

	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(': ping\n\n'));
			pingInterval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch (_) { /* controller 已关闭 */ }
			}, 10000);
		},
		async pull(controller) {
			let enqueuedAny = false;
			const originalEnqueue = controller.enqueue.bind(controller);
			controller.enqueue = (chunk) => {
				enqueuedAny = true;
				originalEnqueue(chunk);
			};

			try {
				while (true) {
					const result = await readWithTimeout(reader, 120000);
					if (result.done) {
						if (buffer.trim()) {
							buffer = processLines(buffer, controller);
							if (buffer.trim()) {
								controller.enqueue(encoder.encode(`${buffer.trim()}\n\n`));
							}
						}
						ensureFinishReason(controller, 'stop');
						controller.enqueue(encoder.encode('data: [DONE]\n\n'));
						controller.close();
					if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
					accumulateFromUsage(env, ctx, streamUsage, requestStartTime, model);
						break;
					}

					buffer += decoder.decode(result.value, { stream: true });
					buffer = processLines(buffer, controller);

					if (buffer.indexOf('\n') === -1 && enqueuedAny) {
						break;
					}
					enqueuedAny = false;
				}
			} catch (e) {
				console.error(`passthroughStream upstream error: ${e?.message || e}`);
				try {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					ensureFinishReason(controller, 'error');
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
				} catch (e2) { console.error('passthroughStream secondary error:', e2?.message || e2); }
				if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
				try { controller.close(); } catch (_) { }
			}
		},
		cancel() {
			if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
			return reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') continue;

				try {
				let chunk = JSON.parse(dataStr);
				// 流式格式归一化：CF Binding 流式返回原生格式 {response, usage, tool_calls}，
				// 转成 OpenAI streaming chunk {choices: [{delta: {content}, finish_reason: null}]}
				if (!chunk.choices && chunk.response !== undefined) {
					const originalUsage = chunk.usage;
					chunk = {
						id: chunk.id || `chatcmpl-${crypto.randomUUID()}`,
						object: 'chat.completion.chunk',
						created: chunk.created || Math.floor(Date.now() / 1000),
						model: modelName,
						choices: [{ index: 0, delta: { content: chunk.response }, finish_reason: null }]
					};
					if (originalUsage) chunk.usage = originalUsage;
				}

					if (chunk.choices && chunk.choices.some(c => c.finish_reason != null)) sawFinishReason = true;
					if (chunk.id !== undefined) lastChunkId = chunk.id;
					if (chunk.created !== undefined) lastChunkCreated = chunk.created;
					if (chunk.model !== undefined) chunk.model = modelName;
					if (chunk.usage) streamUsage = chunk.usage;
					if (isCompletion) {
						chunk.object = 'text_completion';
						if (chunk.choices) {
							for (const c of chunk.choices) {
								if (c.delta?.content !== undefined) {
									c.text = c.delta.content;
									delete c.delta;
								}
								if (c.message?.content !== undefined) {
									c.text = c.message.content;
									delete c.message;
								}
							}
						}
					}
					// 清理 CF 非标准字段，避免污染 OpenAI 兼容客户端
					if (chunk.p !== undefined) delete chunk.p;
					if (chunk.matched_stop !== undefined) delete chunk.matched_stop;
					if (Array.isArray(chunk.choices)) {
						for (const c of chunk.choices) {
							if (c.matched_stop !== undefined) delete c.matched_stop;
						}
					}
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				} catch (_) {
					controller.enqueue(encoder.encode(`${line}\n`));
				}
			} else {
				controller.enqueue(encoder.encode(`${line}\n`));
			}
		}
		return remaining;
	}
}

async function safeJsonBody(request) {
	const ct = request.headers.get('Content-Type') || '';
	// 空 Content-Type 放行（CF request.json() 不要求该头）；仅拒绝明确的非 JSON 类型（如 multipart）
	if (ct && !ct.includes('application/json') && !ct.includes('text/plain')) return null;
	try { return await request.json(); } catch { return null; }
}

function streamResponse(stream, fallbackWarning) {
	const headers = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' };
	if (fallbackWarning) headers['X-Model-Fallback-Warning'] = fallbackWarning;
	return new Response(stream, { headers });
}

function jsonResponse(data, fallbackWarning) {
	const headers = { 'Content-Type': 'application/json' };
	if (fallbackWarning) headers['X-Model-Fallback-Warning'] = fallbackWarning;
	return new Response(JSON.stringify(data), { headers });
}

// ===== handleDashboardApi - 简化版（无多账号） =====
async function handleDashboardApi(request, env, ctx) {
	const url = new URL(request.url);
	const method = request.method;

	// 登录
	if (url.pathname === '/api/auth/login' && method === 'POST') {
		const { password } = await safeJsonBody(request) || {};
		if (!env.ADMIN_PASSWORD || !env.ADMIN_PASSWORD.trim()) {
			return new Response(JSON.stringify({ error: 'ADMIN_PASSWORD not configured' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
		}
		const expectedPassword = env.ADMIN_PASSWORD.trim();
		const providedHash = await sha256(password || '');
		const expectedHash = await sha256(expectedPassword);
		if (timingSafeEqual(providedHash, expectedHash)) {
			const token = await sha256(password);
			return new Response(JSON.stringify({ success: true }), {
				headers: {
					'Content-Type': 'application/json',
					'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
				}
			});
		} else {
			return new Response(JSON.stringify({ error: 'Incorrect password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname === '/api/auth/logout' && method === 'POST') {
		return new Response(JSON.stringify({ success: true }), {
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': `admin_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
			}
		});
	}

	// 用量汇总（真实 Neurons 口径：GraphQL Analytics，与模式B一致）
	if (url.pathname === '/api/usage/summary' && method === 'GET') {
		const isAuthorized = await checkAdminAuth(request, env);
		if (!isAuthorized) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}

		{
			const limits = await getUsageLimits(env);
			const accounts = await getAccounts(env);
			const monthlyUsage = await getMonthlyUsage(env);

			// 汇总缓存中各账号今日数据（模式B写入的 cache_usage_details，两模式共用KV同口径）
			const cachedDetailsRaw = await env.KV.get('cache_usage_details');
			let cacheMap = {};
			if (cachedDetailsRaw) {
				try { cacheMap = JSON.parse(cachedDetailsRaw) || {}; } catch (e) { cacheMap = {}; }
			}
			const todayStr = getTodayStr();
			let totalNeuronsToday = 0;
			let totalRequestsToday = 0;
			let totalRequestsMonth = 0;
			const modelsToday = {};
			for (const account of accounts) {
				const cachedItem = cacheMap[account.id];
				if (!cachedItem) continue;
				if (cachedItem.todayDate === todayStr) {
					totalNeuronsToday += cachedItem.usageToday || 0;
					totalRequestsToday += cachedItem.usageTodayRequests || 0;
					if (cachedItem.modelsToday) {
						cachedItem.modelsToday.forEach(m => {
							modelsToday[m.model] = (modelsToday[m.model] || 0) + m.neurons;
						});
					}
				} else if (cachedItem.history) {
					const todayEntry = cachedItem.history.find(h => h.date === todayStr);
					if (todayEntry) {
						totalNeuronsToday += todayEntry.neurons;
						if (todayEntry.requests) totalRequestsToday += todayEntry.requests;
					}
				}
				if (cachedItem.usageThisMonthRequests) totalRequestsMonth += cachedItem.usageThisMonthRequests;
			}
			const formattedModelsToday = Object.keys(modelsToday).map(model => ({ model, neurons: modelsToday[model] }));

			const summary = {
				totalNeuronsToday,
				totalRequestsToday,
				totalRequestsMonth,
				totalAccounts: accounts.length,
				totalLimit: limits.dailyLimit,
				usagePercentage: limits.dailyLimit > 0 ? parseFloat(((totalNeuronsToday / limits.dailyLimit) * 100).toFixed(2)) : 0,
				modelsToday: formattedModelsToday,
				dailyUsage: totalNeuronsToday,
				dailyLimit: limits.dailyLimit,
				monthlyUsage: monthlyUsage,
				monthlyLimit: limits.monthlyLimit,
				threshold: limits.threshold,
				dailyRequests: totalRequestsToday,
				monthlyRequests: totalRequestsMonth
			};
			return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json', 'X-Request-Id': generateRequestId() } });
		}
	}

	const isAuthorized = await checkAdminAuth(request, env);
	if (!isAuthorized) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
	}

	// CSRF 防护
	if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
		const cookies = request.headers.get('Cookie') || '';
		const csrfCookieMatch = cookies.match(/csrf_token=([^;]+)/);
		const csrfCookie = csrfCookieMatch ? csrfCookieMatch[1] : null;
		const csrfHeader = request.headers.get('X-CSRF-Token');
		if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
			return new Response(JSON.stringify({ error: 'CSRF token validation failed. Please refresh the page.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 获取账号信息（简化版：返回单账号信息）
	if (url.pathname === '/api/accounts' && method === 'GET') {
		return new Response(JSON.stringify([{
			id: 'binding-single',
			name: 'AI Binding (Single Account)',
			accountId: 'binding',
			apiToken: '********',
			status: 'active'
		}]), { headers: { 'Content-Type': 'application/json' } });
	}

	// 账号用量（真实 Neurons 口径：GraphQL Analytics，与模式B一致）
	if (url.pathname === '/api/accounts/usage' && method === 'GET') {
		const limits = await getUsageLimits(env);
		const accounts = await getAccounts(env);
		const monthlyUsage = await getMonthlyUsage(env);

		// 无模式B账号配置时返回空数据（兼容模式A单账号部署）
		if (accounts.length === 0) {
			return new Response(JSON.stringify({
				accounts: [],
				limits: { dailyUsage: 0, dailyRequests: 0, dailyLimit: limits.dailyLimit, monthlyUsage: 0, monthlyRequests: 0, monthlyLimit: limits.monthlyLimit, threshold: limits.threshold }
			}), { headers: { 'Content-Type': 'application/json' } });
		}

		// 刷新 GraphQL 缓存（与模式B refreshAccountsUsage 同逻辑同KV键，保证两模式看板一致）
		const cacheMap = await refreshAccountsUsage(env, accounts);

		const todayStr = getTodayStr();
		const results = accounts.map(account => {
			const cached = cacheMap[account.id];
			let usageToday = 0;
			let usageTodayRequests = 0;
			if (cached) {
				if (cached.todayDate === todayStr) {
					usageToday = cached.usageToday || 0;
					usageTodayRequests = cached.usageTodayRequests || 0;
				} else if (cached.history) {
					const todayEntry = cached.history.find(h => h.date === todayStr);
					usageToday = todayEntry ? todayEntry.neurons : 0;
					usageTodayRequests = todayEntry && todayEntry.requests ? todayEntry.requests : 0;
				}
			}
			return {
				id: account.id,
				name: account.name,
				accountId: account.accountId,
				status: cached ? cached.status : 'pending',
				error: cached ? cached.error : undefined,
				usageToday,
				usageTodayRequests,
				modelsToday: cached && cached.todayDate === todayStr ? (cached.modelsToday || []) : [],
				history: cached ? cached.history : [],
				lastUpdated: cached ? cached.timestamp : 0
			};
		});

		// 汇总今日用量和请求次数
		let dailyUsage = 0;
		let dailyRequests = 0;
		let monthlyRequests = 0;
		results.forEach(a => { dailyUsage += a.usageToday || 0; dailyRequests += a.usageTodayRequests || 0; });
		// 月度数据
		for (const [, data] of Object.entries(cacheMap)) {
			if (data.usageThisMonthRequests) monthlyRequests += data.usageThisMonthRequests;
		}

		return new Response(JSON.stringify({
			accounts: results,
			limits: { dailyUsage, dailyRequests, dailyLimit: limits.dailyLimit, monthlyUsage, monthlyRequests, monthlyLimit: limits.monthlyLimit, threshold: limits.threshold }
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	// 测试账号连接（模式A：实际调用 env.AI.run 做轻量推理测试，验证 Binding 配置是否有效）
	if (url.pathname === '/api/accounts/test' && method === 'POST') {
		try {
			// 用 embeddinggemma-300m 做轻量测试（与模式 B _worker.js:2862 一致）
			const testResult = await env.AI.run('@cf/google/embeddinggemma-300m', { text: ['test'] }, { signal: AbortSignal.timeout(30000) });
			const ok = testResult && (testResult.data || testResult.shape || testResult.response !== undefined);
			return new Response(JSON.stringify({
				success: !!ok,
				permissions: {
					workersAiRead: { success: !!ok },
					workersAiEdit: { success: !!ok },
					accountAnalyticsRead: { success: !!ok }
				},
				...(!ok ? { error: 'AI Binding test failed: unexpected response format' } : {})
			}), { headers: { 'Content-Type': 'application/json' } });
		} catch (e) {
			return new Response(JSON.stringify({
				success: false,
				error: e.message || 'AI Binding test failed',
				permissions: {
					workersAiRead: { success: false, error: e.message },
					workersAiEdit: { success: false },
					accountAnalyticsRead: { success: false }
				}
			}), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname === '/api/keys') {
		if (method === 'GET') {
			const keys = await getApiKeys(env);
			return new Response(JSON.stringify(keys), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const { name, key } = await safeJsonBody(request) || {};
			if (!name) {
				return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}

			const generatedKey = key || `sk-wa-${crypto.randomUUID().replace(/-/g, '')}`;
			const keys = await getApiKeys(env);
			keys.push({
				id: crypto.randomUUID(),
				name,
				key: generatedKey,
				createdAt: new Date().toISOString()
			});
			await saveApiKeys(env, keys);
			return new Response(JSON.stringify({ success: true, key: generatedKey }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname.startsWith('/api/keys/') && method === 'DELETE') {
		const id = decodeURIComponent(url.pathname.slice('/api/keys/'.length));
		const keys = await getApiKeys(env);
		const filtered = keys.filter(k => k.id !== id);
		await saveApiKeys(env, filtered);
		return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname === '/api/settings') {
		if (method === 'GET') {
			const customMap = await getCustomModelMap(env);
			const modelTokens = await getModelTokens(env);
			return new Response(JSON.stringify({ customModelMap: customMap, modelTokens }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'PUT') {
			const body = await safeJsonBody(request) || {};
			const { customModelMap, modelTokens } = body;
			if (modelTokens && typeof modelTokens === 'object') {
				await saveModelTokens(env, modelTokens);
			}
			if (customModelMap && typeof customModelMap === 'object') {
				await saveCustomModelMap(env, customModelMap);
			}
			if (!customModelMap && !modelTokens) {
				return new Response(JSON.stringify({ error: 'Invalid payload: need customModelMap or modelTokens' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 查询当前账号的 @cf/ 免费模型列表（通过 Workers AI Binding）
	if (url.pathname === '/api/models/search' && method === 'GET') {
		try {
			const allModels = await env.AI.models({ hide_experimental: true, per_page: 200 });
			const freeModels = allModels
				.filter(m => m.name && m.name.startsWith('@cf/'))
				.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
				.map(m => ({
					id: m.name,
					name: m.name,
					description: m.description || '',
					task: m.task?.name || '',
				}));
			return new Response(JSON.stringify({ models: freeModels }), { headers: { 'Content-Type': 'application/json' } });
		} catch (e) {
			return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
		}
	}

	if (url.pathname === '/api/limits') {
		if (method === 'GET') {
			const limits = await getUsageLimits(env);
			return new Response(JSON.stringify(limits), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'PUT') {
			const body = await safeJsonBody(request);
			const { dailyLimit, monthlyLimit, threshold } = body || {};
			const updates = {};
			if (dailyLimit !== undefined) {
				const val = parseInt(dailyLimit, 10);
				if (isNaN(val) || val < 0) {
					return new Response(JSON.stringify({ error: 'dailyLimit must be a non-negative integer' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.dailyLimit = val;
			}
			if (monthlyLimit !== undefined) {
				const val = parseInt(monthlyLimit, 10);
				if (isNaN(val) || val < 0) {
					return new Response(JSON.stringify({ error: 'monthlyLimit must be a non-negative integer' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.monthlyLimit = val;
			}
			if (threshold !== undefined) {
				const val = parseFloat(threshold);
				if (isNaN(val) || val < 0 || val > 1) {
					return new Response(JSON.stringify({ error: 'threshold must be a number between 0 and 1' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
				}
				updates.threshold = val;
			}
			if (Object.keys(updates).length === 0) {
				return new Response(JSON.stringify({ error: 'No valid fields provided' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}

			await saveUsageLimitsConfig(env, updates);

			const newLimits = await getUsageLimits(env);
			return new Response(JSON.stringify({ success: true, limits: newLimits }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 今日 Token 统计
	if (url.pathname === '/api/tokens/today' && method === 'GET') {
		const stats = await getTodayTokenStats(env);
		const _ft = n => n < 1000 ? String(n) : n < 1000000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : n < 1000000000 ? (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M' : (n / 1000000000).toFixed(2).replace(/\.?0+$/, '') + 'B';
		return new Response(JSON.stringify({
			input: stats.input,
			output: stats.output,
			reasoning: stats.reasoning,
			cacheRead: stats.cacheRead,
			cacheWrite: stats.cacheWrite,
			total: stats.total,
			requests: stats.requests,
			avgTokPerSec: stats.avgTokPerSec,
			inputFmt: _ft(stats.input),
			outputFmt: _ft(stats.output),
			reasoningFmt: _ft(stats.reasoning),
			totalFmt: _ft(stats.total),
			cacheReadFmt: _ft(stats.cacheRead),
			cacheWriteFmt: _ft(stats.cacheWrite),
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}



const SHARED_JS = `
		function showToast(message, type = 'success') {
			let container = document.querySelector('.toast-container');
			if (!container) {
				container = document.createElement('div');
				container.className = 'toast-container';
				document.body.appendChild(container);
			}

			const toast = document.createElement('div');
			toast.className = \`toast toast-\${type}\`;
			
			let iconSvg = '';
			if (type === 'success') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else if (type === 'error') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>\`;
			}

			toast.innerHTML = iconSvg;
			const msgSpan = document.createElement('span');
			msgSpan.textContent = message;
			toast.appendChild(msgSpan);
			container.appendChild(toast);

			toast.offsetHeight; // trigger reflow
			toast.classList.add('show');

			setTimeout(() => {
				toast.classList.remove('show');
				setTimeout(() => toast.remove(), 400);
			}, 3000);
		}

		function initTheme() {
			const savedTheme = localStorage.getItem('theme');
			if (savedTheme) {
				document.documentElement.setAttribute('data-theme', savedTheme);
			} else {
				const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				const defaultTheme = systemPrefersDark ? 'dark' : 'light';
				document.documentElement.setAttribute('data-theme', defaultTheme);
			}
			updateThemeIcons();
		}

		function updateThemeIcons() {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const sunIcons = document.querySelectorAll('.theme-icon-sun');
			const moonIcons = document.querySelectorAll('.theme-icon-moon');
			if (currentTheme === 'light') {
				sunIcons.forEach(el => el.style.display = 'none');
				moonIcons.forEach(el => el.style.display = 'block');
			} else {
				sunIcons.forEach(el => el.style.display = 'block');
				moonIcons.forEach(el => el.style.display = 'none');
			}
		}

		function escapeHtml(str) {
			if (str === null || str === undefined) return '';
			return String(str)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		function attrEscape(str) {
			return escapeHtml(JSON.stringify(String(str)));
		}

		async function copyText(text, msg) {
			try {
				await navigator.clipboard.writeText(text);
				showToast(msg || '已复制！');
			} catch (_) {
				showToast('复制失败，请手动复制', 'error');
			}
		}

		async function deleteResource(apiPath, id, loadFn, successMsg, errorMsg) {
			const res = await apiFetch(apiPath + encodeURIComponent(id), { method: 'DELETE' });
			if (res.ok) { loadFn(); showToast(successMsg); }
			else { showToast(errorMsg || '删除失败', 'error'); }
		}

		// 共享的 toggleTheme（通过回调参数在主题切换后触发页面特定的重渲染）
		function toggleTheme(onThemeChange) {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const newTheme = currentTheme === 'light' ? 'dark' : 'light';
			document.documentElement.setAttribute('data-theme', newTheme);
			localStorage.setItem('theme', newTheme);
			updateThemeIcons();
			if (typeof onThemeChange === 'function') onThemeChange();
		}

		// 共享的图表 Legend 渲染函数
		const CHART_COLORS = ['#6366f1', '#a855f7', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'];
		function renderChartLegend(legendContainer, labels, data, fullLabels) {
			if (!legendContainer) return;
			legendContainer.innerHTML = '';
			const isLight = document.documentElement.getAttribute('data-theme') === 'light';
			const textColor = isLight ? '#64748b' : '#94a3b8';
			const total = data.reduce((a, b) => a + b, 0);

			labels.forEach((label, index) => {
				const val = data[index];
				const color = CHART_COLORS[index % CHART_COLORS.length];
				const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
				const title = fullLabels ? fullLabels[index] : label;

				const item = document.createElement('div');
				item.style.display = 'flex';
				item.style.alignItems = 'center';
				item.style.gap = '8px';
				item.style.fontSize = '12px';
				item.style.color = textColor;
				item.style.opacity = '0';
				item.style.transform = 'translateX(10px)';
				item.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';

				item.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background-color: ' + color + '; flex-shrink: 0; margin-right: 2px;"></span>' +
					'<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; font-weight: 500;" title="' + escapeHtml(title) + '">' + escapeHtml(label) + '</span>' +
					'<span style="color: var(--text-muted); font-family: monospace; font-size: 11px; flex-shrink: 0; margin-left: 4px;">' + pct + '%</span>';

				legendContainer.appendChild(item);
				setTimeout(() => {
					item.style.opacity = '1';
					item.style.transform = 'translateX(0)';
				}, index * 80);
			});
		}

		function createDoughnutChart(canvasId, labels, data, borderColor) {
			const ctx = document.getElementById(canvasId).getContext('2d');
			return new Chart(ctx, {
				type: 'doughnut',
				data: {
					labels: labels,
					datasets: [{
						data: data,
						backgroundColor: ['#6366f1', '#a855f7', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'],
						borderWidth: 2,
						borderColor: borderColor
					}]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					cutout: '70%',
					animation: {
						animateRotate: true,
						animateScale: true,
						duration: 1000,
						easing: 'easeOutQuart'
					},
					plugins: {
						legend: { display: false }
					}
				}
			});
		}`;

const SHARED_BG_CSS = `
		.bg-orbs-container {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
		}

		.bg-orb {
			position: absolute;
			border-radius: 50%;
			filter: blur(100px);
		}

		.bg-orb-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: var(--orb-1-color); }
		.bg-orb-2 { bottom: -10%; right: -10%; width: 60vw; height: 60vw; background: var(--orb-2-color); }`;

// 两个页面共享的图表 wrapper CSS（含移动端响应式）
const SHARED_CHART_CSS = `
		.public-chart-wrapper {
			position: relative;
			height: 190px;
			width: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 40px;
			overflow: hidden;
		}

		.public-chart-wrapper canvas {
			max-width: 100% !important;
		}

		.chart-legend {
			scrollbar-width: none;
			-ms-overflow-style: none;
		}
		.chart-legend::-webkit-scrollbar {
			display: none;
		}

		@media (max-width: 768px) {
			.public-chart-wrapper {
				flex-direction: column !important;
				height: auto !important;
				padding: 10px 0;
				gap: 20px !important;
			}
			.public-chart-wrapper > div:first-child {
				width: 160px !important;
				height: 160px !important;
			}
			.public-chart-wrapper > div:nth-child(2) {
				width: 100% !important;
				height: auto !important;
				align-items: center !important;
			}
			.chart-legend {
				width: 100%;
				display: grid !important;
				grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
				gap: 8px !important;
				max-height: none !important;
			}
		}`;
const SHARED_THEME_CSS = `
		:root {
			--bg-color: #0b0f19;
			--card-bg: rgba(30, 41, 59, 0.45);
			--border-color: rgba(255, 255, 255, 0.08);
			--text-main: #f8fafc;
			--text-muted: #94a3b8;
			--primary-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
			--accent-color: #a855f7;
			--input-bg: rgba(15, 23, 42, 0.6);
			--input-border: rgba(255, 255, 255, 0.1);
			--input-text: #f8fafc;
			--btn-secondary-bg: rgba(255, 255, 255, 0.06);
			--btn-secondary-hover: rgba(255, 255, 255, 0.12);
			--btn-secondary-text: #f8fafc;
			--modal-overlay-bg: rgba(8, 10, 18, 0.6);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
			--orb-1-color: rgba(99, 102, 241, 0.15);
			--orb-2-color: rgba(236, 72, 153, 0.12);
		}

		:root[data-theme="light"] {
			--bg-color: #f1f5f9;
			--card-bg: rgba(255, 255, 255, 0.7);
			--border-color: rgba(0, 0, 0, 0.06);
			--text-main: #0f172a;
			--text-muted: #64748b;
			--primary-gradient: linear-gradient(135deg, #4f46e5 0%, #9333ea 50%, #db2777 100%);
			--accent-color: #9333ea;
			--input-bg: rgba(241, 245, 249, 0.8);
			--input-border: rgba(0, 0, 0, 0.08);
			--input-text: #0f172a;
			--btn-secondary-bg: rgba(0, 0, 0, 0.04);
			--btn-secondary-hover: rgba(0, 0, 0, 0.08);
			--btn-secondary-text: #0f172a;
			--modal-overlay-bg: rgba(241, 245, 249, 0.5);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
			--orb-1-color: rgba(99, 102, 241, 0.08);
			--orb-2-color: rgba(236, 72, 153, 0.06);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		.hidden {
			display: none !important;
		}
`;

const SHARED_TOAST_CSS = `
		.toast-container {
			position: fixed;
			top: 24px;
			right: 24px;
			display: flex;
			flex-direction: column;
			gap: 10px;
			z-index: 9999;
			pointer-events: none;
		}

		.toast {
			min-width: 260px;
			padding: 14px 20px;
			border-radius: 12px;
			box-shadow: var(--card-shadow);
			font-size: 14px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 12px;
			backdrop-filter: blur(15px);
			-webkit-backdrop-filter: blur(15px);
			transform: translateY(-20px);
			opacity: 0;
			transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
			pointer-events: auto;
		}

		.toast.show {
			transform: translateY(0);
			opacity: 1;
		}

		.toast-icon {
			width: 20px;
			height: 20px;
			flex-shrink: 0;
		}

		.toast-success {
			background-color: #10b981 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-success .toast-icon, .toast-success span {
			color: #ffffff !important;
		}

		.toast-error {
			background-color: #ef4444 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-error .toast-icon, .toast-error span {
			color: #ffffff !important;
		}
		
		.toast-warning {
			background-color: #f59e0b !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-warning .toast-icon, .toast-warning span {
			color: #ffffff !important;
		}
`;

// 统计卡片骨架（.stat-value / .stat-desc 等字号差异在各页面内覆盖）
const SHARED_STAT_CARD_CSS = `
		.stat-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			padding: 28px 26px;
			display: flex;
			flex-direction: column;
			gap: 16px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: transform 0.35s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.35s, border-color 0.35s;
			min-width: 0;
			overflow: hidden;
			position: relative;
		}

		.stat-card::before {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			height: 3px;
			background: var(--primary-gradient);
			opacity: 0;
			transition: opacity 0.35s;
		}

		.stat-card:hover {
			transform: translateY(-4px);
			border-color: rgba(168, 85, 247, 0.35);
			box-shadow: 0 16px 40px rgba(168, 85, 247, 0.12);
		}

		.stat-card:hover::before {
			opacity: 1;
		}

		.stat-title {
			font-size: 13px;
			color: var(--text-muted);
			font-weight: 600;
			letter-spacing: 0.02em;
			text-transform: uppercase;
		}`;

// 表单输入框（.form-group 因页面布局差异保留在各页面内）
const SHARED_FORM_CSS = `
		.form-group label {
			font-size: 13px;
			font-weight: 500;
			color: var(--text-muted);
		}

		input {
			background-color: var(--input-bg);
			border: 1px solid var(--input-border);
			color: var(--input-text);
			padding: 12px 16px;
			border-radius: 10px;
			outline: none;
			font-size: 14px;
			transition: all 0.3s ease;
			backdrop-filter: blur(10px);
		}

		input:focus {
			border-color: var(--accent-color);
			box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.2);
			background-color: rgba(15, 23, 42, 0.8);
		}

		:root[data-theme="light"] input:focus {
			background-color: rgba(255, 255, 255, 0.95);
			box-shadow: 0 0 0 3px rgba(147, 51, 234, 0.15);
		}`;

// 按钮主/次态（.btn 基础因 padding/gap 差异保留在各页面内）
const SHARED_BUTTON_CSS = `
		.btn-primary {
			background: var(--primary-gradient);
			color: white;
			box-shadow: 0 4px 14px rgba(168, 85, 247, 0.3);
		}

		.btn-primary:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(168, 85, 247, 0.5);
			opacity: 0.95;
		}

		.btn-primary:active {
			transform: translateY(0);
		}

		.btn-secondary {
			background-color: var(--btn-secondary-bg);
			color: var(--btn-secondary-text);
			border: 1px solid var(--border-color);
		}

		.btn-secondary:hover {
			background-color: var(--btn-secondary-hover);
			transform: translateY(-1px);
		}`;

// 模态框骨架（.modal-card 的 max-width 差异在各页面内覆盖）
const SHARED_MODAL_CSS = `
		.modal-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background-color: var(--modal-overlay-bg);
			backdrop-filter: blur(0px);
			-webkit-backdrop-filter: blur(0px);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.3s ease, backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease;
		}

		.modal-overlay.active {
			opacity: 1;
			pointer-events: auto;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
		}

		.modal-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			width: 90vw;
			max-width: 600px;
			max-height: 85vh;
			padding: 24px;
			box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
			display: flex;
			flex-direction: column;
			gap: 16px;
			transform: scale(0.9) translateY(20px);
			transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.3s;
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
		}

		.modal-overlay.active .modal-card {
			transform: scale(1) translateY(0);
		}

		.modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 16px;
		}

		.modal-header h3 {
			font-size: 18px;
			font-weight: 600;
		}

		.close-btn {
			background: none;
			border: none;
			color: var(--text-muted);
			cursor: pointer;
			padding: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			outline: none;
			transition: color 0.2s;
		}

		.close-btn:hover {
			color: var(--text-main);
		}`;

// 模态框关闭按钮 SVG 图标
const SVG_CLOSE = '<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';




async function handleLandingPage(request, env, ctx) {
	const isLoggedIn = await checkAdminAuth(request, env);

	const html = `<!DOCTYPE html>
<head>
	<meta charset="UTF-8">
	<meta name="robots" content="noindex, nofollow">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>cf-ai-gw - Cloudflare Workers AI Proxy</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@500;600;700&display=swap" rel="stylesheet">
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<style>
		${SHARED_THEME_CSS}

		body {
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			justify-content: center;
			align-items: center;
			padding: 20px;
			overflow-x: hidden;
			position: relative;
		}

		h1, h2, h3 {
			font-family: 'Outfit', sans-serif;
		}

		${SHARED_BG_CSS}

		.action-btn-group {
			position: fixed;
			top: 20px;
			right: 20px;
			display: flex;
			flex-direction: row;
			gap: 12px;
			z-index: 1000;
		}

		.floating-btn {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			color: var(--text-main);
			width: 44px;
			height: 44px;
			border-radius: 12px;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			z-index: 1000;
			outline: none;
		}
		
		.floating-btn:hover {
			transform: translateY(-2px);
			border-color: rgba(168, 85, 247, 0.4);
			box-shadow: 0 8px 20px rgba(168, 85, 247, 0.15);
		}

		.dashboard-container {
			max-width: 900px;
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 28px;
			z-index: 10;
		}

		.dashboard-grid {
			display: grid;
			grid-template-columns: 1fr 2fr;
			gap: 20px;
			width: 100%;
		}

		${SHARED_CHART_CSS}

		@media (max-width: 768px) {
			.dashboard-grid {
				grid-template-columns: 1fr !important;
			}
		}

		@keyframes spinner-border {
			to { transform: rotate(360deg); }
		}

		.spinner {
			display: inline-block;
			width: 16px;
			height: 16px;
			border: 2px solid rgba(168, 85, 247, 0.2);
			border-radius: 50%;
			border-top-color: var(--accent-color);
			animation: spinner-border 1s linear infinite;
		}

		.login-header {
			display: flex;
			flex-direction: row;
			align-items: center;
			justify-content: center;
			gap: 16px;
			margin-bottom: 8px;
		}

		.logo-icon {
			width: 46px;
			height: 46px;
			border-radius: 12px;
			background: var(--primary-gradient);
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: bold;
			color: white;
			font-size: 22px;
			font-family: 'Outfit', sans-serif;
			box-shadow: 0 4px 14px rgba(168, 85, 247, 0.25);
		}

		.logo-text {
			font-size: 24px;
			font-weight: 700;
			letter-spacing: -0.5px;
			background: var(--primary-gradient);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		${SHARED_STAT_CARD_CSS}

		.stat-value {
			font-size: 36px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
		}

		.section-title {
			font-size: 18px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.form-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		${SHARED_FORM_CSS}

		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 12px 20px;
			border-radius: 10px;
			font-weight: 600;
			font-size: 14px;
			cursor: pointer;
			border: none;
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			text-decoration: none;
		}

		${SHARED_BUTTON_CSS}

		/* Modal Styling */
		${SHARED_MODAL_CSS}

		.modal-card {
			max-width: 400px;
		}

		${SHARED_TOAST_CSS}
	</style>
</head>
<body>

	
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>

	
	<div class="action-btn-group">
		<button class="floating-btn" onclick="toggleTheme(onThemeChange)" title="切换日间/夜间模式">
			<svg class="theme-icon-sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none; width: 20px; height: 20px;">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
			</svg>
			<svg class="theme-icon-moon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
				<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
			</svg>
		</button>
		<button class="floating-btn" onclick="${isLoggedIn ? "window.location.href='/admin'" : 'openLoginModal()'}" title="${isLoggedIn ? '管理后台' : '管理员登录'}" style="background: var(--primary-gradient); color: white; border: none;">
			${isLoggedIn ? `
				<!-- User Check Icon -->
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
					<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
					<circle cx="9" cy="7" r="4" />
					<polyline points="16 11 18 13 22 9" />
				</svg>
			` : `
				<!-- User Icon -->
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
					<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
					<circle cx="12" cy="7" r="4" />
				</svg>
			`}
		</button>
	</div>

	<div class="dashboard-container">
		<div class="login-header" style="margin-bottom: 8px;">
			<div class="logo-icon">AI</div>
			<span class="logo-text">cf-ai-gw</span>
		</div>

		<div class="dashboard-grid">
			
			<div class="stat-card" style="justify-content: space-between;">
				<div>
					<div class="stat-title" style="margin-bottom: 10px;">今日用量汇总</div>
					<div style="display: flex; align-items: baseline; gap: 4px;">
						<div class="stat-value" id="public-neurons" style="font-size: 42px; background: var(--primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; display: inline-block;">0</div>
						<span style="font-size: 14px; color: var(--text-muted); font-weight: 500; font-family: 'Outfit', sans-serif;">Neurons</span>
					</div>
				</div>
				
				<div style="margin-top: 16px;">
					<div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 8px;">
						<span id="public-limit-desc">总限额: 0 Neurons</span>
						<span id="public-percent-desc" style="font-weight: 600; color: var(--accent-color);">0.00%</span>
					</div>
				</div>
			</div>
			
			<div class="stat-card" id="public-models-card" style="padding: 24px; display: flex; flex-direction: column; justify-content: center;">
				
				<div class="public-chart-wrapper" id="public-chart-wrapper" style="display: none; height: 190px; width: 100%; flex-direction: row; align-items: center; justify-content: space-between; gap: 40px;">
					
					<div style="position: relative; height: 190px; width: 190px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
						<canvas id="publicModelsChart"></canvas>
					</div>
					
					<div style="flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0; align-self: stretch; height: 190px;">
						<div id="public-chart-legend" class="chart-legend" style="flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-height: 180px; overflow-y: auto; padding-right: 4px;"></div>
					</div>
				</div>
				
				
				<div id="public-chart-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 190px; width: 100%; color: var(--text-muted); font-size: 13px; gap: 12px;">
					<span class="spinner" style="width: 24px; height: 24px; border-width: 2.5px;"></span>
					<span>正在载入数据...</span>
				</div>
			</div>
		</div>
	</div>

	<!-- 弹窗：管理员登录 / 后台快捷入口 -->
	<div class="modal-overlay" id="login-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3 id="modal-title">${isLoggedIn ? '管理面板入口' : '管理员登录'}</h3>
				<button onclick="closeLoginModal()" class="close-btn">${SVG_CLOSE}</button>
			</div>
			
			${isLoggedIn ? `
				<div style="text-align: center; display: flex; flex-direction: column; gap: 16px; margin-top: 10px;">
					<div style="font-size: 40px; margin-bottom: 8px;">🎉</div>
					<p style="font-size: 14px; color: var(--text-muted); line-height: 1.5;">您当前已登录管理员身份。</p>
					<a href="/admin" class="btn btn-primary" style="width: 100%; text-decoration: none; display: flex; align-items: center; justify-content: center; height: 42px;">进入后台管理面板</a>
					<button class="btn btn-secondary" onclick="submitLogout()" style="width: 100%; height: 42px;">安全退出</button>
				</div>
			` : `
				<div class="form-group" style="margin-top: 10px;">
					<label for="login-password">管理员密码</label>
					<input type="password" id="login-password" placeholder="请输入管理员密码" onkeydown="if(event.key==='Enter')submitLogin()">
				</div>
				<div class="modal-footer" style="margin-top: 10px; display: flex; gap: 12px; justify-content: flex-end; width: 100%;">
					<button class="btn btn-secondary" onclick="closeLoginModal()" style="height: 38px;">取消</button>
					<button class="btn btn-primary" onclick="submitLogin()" style="height: 38px;">登录</button>
				</div>
			`}
		</div>
	</div>

	<!-- Modal: Select Free Model -->
	<div class="modal-overlay" id="model-select-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3>选择 @cf/ 免费模型</h3>
				<button onclick="document.getElementById('model-select-modal').classList.remove('active')" class="close-btn">${SVG_CLOSE}</button>
			</div>
			<div style="margin-bottom: 12px; font-size: 13px; color: var(--text-muted);">点击模型自动新增映射：左侧为简称，右侧为完整路径</div>
			<div style="margin-bottom: 10px;">
				<input type="text" id="model-search-input" placeholder="搜索模型..." oninput="filterModelList()"
					   style="width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; box-sizing: border-box;">
			</div>
			<div id="model-select-list" style="flex: 1; min-height: 0; max-height: 55vh; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px;">
				<div style="text-align: center; padding: 30px; color: var(--text-muted);">加载中...</div>
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" onclick="document.getElementById('model-select-modal').classList.remove('active')">关闭</button>
			</div>
		</div>
	</div>

	<script>
		${SHARED_JS}

		let publicModelsChartInstance = null;
		let lastPublicSummaryData = null;

		function onThemeChange() {
			if (lastPublicSummaryData) renderPublicSummary(lastPublicSummaryData);
		}

		function openLoginModal() {
			document.getElementById('login-modal').classList.add('active');
			const pwdInput = document.getElementById('login-password');
			if (pwdInput) {
				pwdInput.value = '';
				setTimeout(() => pwdInput.focus(), 100);
			}
		}

		function closeLoginModal() {
			document.getElementById('login-modal').classList.remove('active');
		}

		initTheme();

		window.onload = function() {
			loadPublicSummary();
		};

		async function loadPublicSummary() {
			try {
				const res = await fetch('/api/usage/summary');
				if (res.status === 401) {
					// 未登录：隐藏用量卡片和模型图表，不显示 spinner
					const publicCard = document.querySelector('.dashboard-grid .stat-card');
					if (publicCard) publicCard.style.display = 'none';
					const modelsCard = document.getElementById('public-models-card');
					if (modelsCard) modelsCard.style.display = 'none';
					return;
				}
				const data = await res.json();
				renderPublicSummary(data);
			} catch (e) {
				console.error(e);
				// 网络错误时隐藏 spinner，显示空状态
				const placeholder = document.getElementById('public-chart-placeholder');
				if (placeholder) {
					placeholder.innerHTML = '<span style="font-size: 13px;">数据加载失败</span>';
				}
			}
		}

		function animateNumber(id, end, duration = 1200) {
			const obj = document.getElementById(id);
			if (!obj) return;
			let start = parseInt(obj.innerText.replace(/,/g, ''), 10);
			if (isNaN(start) || start <= 0) {
				start = end > 100 ? 100 : 0;
			}
			const range = end - start;
			if (range === 0) {
				obj.innerText = end.toLocaleString();
				return;
			}
			const startTime = performance.now();
			function update(currentTime) {
				const elapsed = currentTime - startTime;
				const progress = Math.min(elapsed / duration, 1);
				const easeProgress = 1 - Math.pow(2, -10 * progress);
				const current = Math.ceil(start + range * easeProgress);
				obj.innerText = current.toLocaleString();
				if (progress < 1) {
					requestAnimationFrame(update);
				} else {
					obj.innerText = end.toLocaleString();
				}
			}
			requestAnimationFrame(update);
		}

		function renderPublicSummary(data) {
			lastPublicSummaryData = data;
			const percent = Number(data.usagePercentage).toFixed(2);
			const roundedNeurons = Math.ceil(data.totalNeuronsToday);
			
			// 触发数字滚动的动效
			animateNumber('public-neurons', roundedNeurons, 1000);
			
			document.getElementById('public-limit-desc').innerText = '总限额: ' + Number(data.totalLimit).toLocaleString() + ' Neurons';
			document.getElementById('public-percent-desc').innerText = percent + '%';

			const wrapper = document.getElementById('public-chart-wrapper');
			const placeholder = document.getElementById('public-chart-placeholder');
			const legendContainer = document.getElementById('public-chart-legend');

			if (data.modelsToday && data.modelsToday.length > 0) {
				if (wrapper) wrapper.style.display = 'flex';
				if (placeholder) placeholder.style.display = 'none';

				// 按 Neurons 消耗数从大到小排序
				const sortedModelsToday = [...data.modelsToday].sort((a, b) => b.neurons - a.neurons);

				const labels = sortedModelsToday.map(m => m.model.split('/').pop());
				const chartData = sortedModelsToday.map(m => m.neurons);
				
				const isLight = document.documentElement.getAttribute('data-theme') === 'light';
				const borderColor = isLight ? '#ffffff' : '#1e293b';
				
				if (publicModelsChartInstance) {
					publicModelsChartInstance.destroy();
				}

				publicModelsChartInstance = createDoughnutChart('publicModelsChart', labels, chartData, borderColor);

				// 动态且逐个淡入渲染模型说明 ID
				renderChartLegend(legendContainer, labels, chartData);
			} else {
				if (wrapper) wrapper.style.display = 'none';
				if (placeholder) {
					placeholder.style.display = 'flex';
					placeholder.innerHTML = '<svg style="width: 32px; height: 32px; opacity: 0.5;" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
						'<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path>' +
						'<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path>' +
						'</svg><span>今日暂无消耗数据</span>';
				}
				if (publicModelsChartInstance) {
					publicModelsChartInstance.destroy();
					publicModelsChartInstance = null;
				}
			}
		}

		async function submitLogin() {
			const password = document.getElementById('login-password').value;
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (res.ok) {
				showToast('登录成功！跳转中...');
				setTimeout(() => {
					window.location.href = '/admin';
				}, 600);
			} else {
				const data = await res.json();
				showToast('登录失败: ' + (data.error || '密码不正确！'), 'error');
			}
		}

		async function submitLogout() {
			const res = await fetch('/api/auth/logout', { method: 'POST' });
			if (res.ok) {
				showToast('安全退出成功');
				setTimeout(() => {
					window.location.reload();
				}, 600);
			}
		}
	</script>
	<footer style="text-align: center; padding: 24px 0 20px; font-size: 12px; color: var(--text-muted); opacity: 0.6; z-index: 10;">
		由 <a href="https://github.com/ojbkxc/cf-ai-gw" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;">cf-ai-gw</a> 强力驱动
	</footer>
</body>
</html>`;

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'DENY'
		}
	});
}

// 2. 后台管理控制台页面
async function handleAdminPage(request, env, ctx) {
	// 生成 CSRF Token：同时写入 cookie（JS 可读）和 meta 标签，前端请求时通过 X-CSRF-Token 头回传
	const csrfToken = await sha256(env.ADMIN_PASSWORD + '_csrf_v1');
	const csrfCookie = `csrf_token=${csrfToken}; Path=/; SameSite=Strict; Secure; Max-Age=86400`;

	const html = `<!DOCTYPE html>
<head>
	<meta charset="UTF-8">
	<meta name="csrf-token" content="${csrfToken}">
	<meta name="robots" content="noindex, nofollow">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>cf-ai-gw Dashboard</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<style>
		${SHARED_THEME_CSS}

		/* Admin 页面特有变量 */
		:root {
			--sidebar-bg: rgba(15, 23, 42, 0.6);
			--success-color: #10b981;
			--warning-color: #f59e0b;
			--danger-color: #ef4444;
			--sidebar-width: 260px;
			--sidebar-menu-hover: rgba(255, 255, 255, 0.04);
			--table-header-bg: rgba(0, 0, 0, 0.2);
			--section-item-bg: rgba(255, 255, 255, 0.02);
			--orb-1-color: rgba(99, 102, 241, 0.12);
			--orb-2-color: rgba(236, 72, 153, 0.08);
			--code-bg: rgba(0, 0, 0, 0.25);
			--code-color: #e9d5ff;
			--code-border: rgba(255, 255, 255, 0.04);
		}

		:root[data-theme="light"] {
			--sidebar-bg: rgba(255, 255, 255, 0.6);
			--sidebar-menu-hover: rgba(0, 0, 0, 0.04);
			--table-header-bg: rgba(0, 0, 0, 0.03);
			--section-item-bg: rgba(0, 0, 0, 0.01);
			--orb-1-color: rgba(99, 102, 241, 0.06);
			--orb-2-color: rgba(236, 72, 153, 0.04);
			--code-bg: rgba(79, 70, 229, 0.07);
			--code-color: #4f46e5;
			--code-border: rgba(79, 70, 229, 0.15);
		}

		body {
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			overflow-x: hidden;
			position: relative;
		}

		/* Tab Content Transition */
		.tab-content { display: none; }
		.tab-content.active { display: block; }

		/* Nav item — gradient bottom border */
		.nav-item::after {
			content: '';
			position: absolute;
			left: 0; right: 0; bottom: 0;
			height: 2px;
			background: linear-gradient(90deg, #6366f1, #a855f7 20%, #ec4899 50%, #a855f7 80%, #6366f1);
			background-size: 200% 100%;
			transform: scaleX(0);
			transform-origin: center;
			transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
		}
		.nav-item.active::after { transform: scaleX(1); }
		:root[data-theme="light"] .nav-item::after {
			background: linear-gradient(90deg, #4f46e5, #7c3aed 20%, #db2777 50%, #7c3aed 80%, #4f46e5);
			background-size: 200% 100%;
		}

		/* Dynamic Background Orbs */
		${SHARED_BG_CSS}

		/* Sidebar Layout */
		.app-container {
			display: flex;
			min-height: 100vh;
			position: relative;
		}

		aside {
			width: var(--sidebar-width);
			background-color: var(--sidebar-bg);
			border-right: 1px solid var(--border-color);
			display: flex;
			flex-direction: column;
			padding: 30px 20px;
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			z-index: 100;
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.logo-area {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 40px;
			padding-left: 8px;
		}

		.logo-icon {
			width: 38px;
			height: 38px;
			border-radius: 10px;
			background: var(--primary-gradient);
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: bold;
			color: white;
			font-size: 18px;
			font-family: 'Outfit', sans-serif;
			box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
		}

		.logo-text {
			font-size: 18px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
			letter-spacing: -0.5px;
			background: var(--primary-gradient);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		.nav-menu {
			display: flex;
			flex-direction: column;
			gap: 8px;
			flex: 1;
		}

		.nav-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 16px;
			border-radius: 10px;
			cursor: pointer;
			font-size: 14px;
			font-weight: 500;
			color: var(--text-muted);
			transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
			position: relative;
			overflow: hidden;
		}

		.nav-item:hover {
			color: var(--text-main);
			background-color: var(--sidebar-menu-hover);
			transform: translateX(4px);
		}

		.nav-item.active {
			color: white;
			background: var(--primary-gradient);
			box-shadow:
				0 0 18px rgba(168, 85, 247, 0.35),
				0 0 40px rgba(99, 102, 241, 0.15),
				inset 0 1px 0 rgba(255, 255, 255, 0.1);
		}

		.aside-footer {
			display: flex;
			flex-direction: column;
			gap: 12px;
			border-top: 1px solid var(--border-color);
			padding-top: 20px;
		}

		/* Main Content Area */
		main {
			flex: 1;
			margin-left: var(--sidebar-width);
			padding: 40px;
			min-width: 0;
			z-index: 10;
		}

		header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 30px;
		}

		/* Card Grid & Stats */
		.card-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
			gap: 20px;
			grid-auto-rows: 1fr;
		}

		${SHARED_STAT_CARD_CSS}

		.stat-value {
			font-size: 38px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
			letter-spacing: -0.02em;
			line-height: 1;
		}

		.stat-desc {
			font-size: 12px;
			color: var(--text-muted);
			line-height: 1.6;
		}

		.stat-metrics-row {
			display: flex;
			gap: 28px;
			align-items: flex-start;
		}

		.stat-metric {
			flex: 1;
			min-width: 0;
		}

		.stat-metric-divider {
			width: 1px;
			background: var(--border-color);
			align-self: stretch;
			margin: 4px 0;
		}

		.stat-icon-badge {
			width: 36px;
			height: 36px;
			border-radius: 10px;
			display: flex;
			align-items: center;
			justify-content: center;
			flex-shrink: 0;
		}

		.usage-progress-container {
			width: 100%;
			height: 8px;
			background: linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.08));
			border-radius: 4px;
			overflow: hidden;
			margin: 10px 0 6px;
			box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);
			position: relative;
		}
		.usage-progress-container::after {
			content: '';
			position: absolute;
			top: 0; left: 0; right: 0;
			height: 50%;
			background: linear-gradient(180deg, rgba(255,255,255,0.15), transparent);
			border-radius: 4px 4px 0 0;
			pointer-events: none;
		}

		:root[data-theme="light"] .usage-progress-container {
			background: linear-gradient(135deg, rgba(0,0,0,0.03), rgba(0,0,0,0.06));
		}
		:root[data-theme="light"] .usage-progress-container::after {
			background: linear-gradient(180deg, rgba(255,255,255,0.5), transparent);
		}

		.usage-progress-bar {
			height: 100%;
			border-radius: 4px;
			transition: width 1.5s cubic-bezier(0.34, 1.56, 0.64, 1);
			position: relative;
			overflow: hidden;
			background: var(--primary-gradient);
			box-shadow: 0 0 8px rgba(168,85,247,0.35);
		}

		/* Section Cards */
		.section-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 18px;
			padding: 30px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			margin-bottom: 24px;
		}

		.section-note {
			margin-top: 6px;
			font-size: 13px;
			color: var(--text-muted);
			line-height: 1.5;
		}

		.access-endpoint-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
			gap: 14px;
		}

		.access-endpoint-card {
			appearance: none;
			width: 100%;
			text-align: left;
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 18px 20px;
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015));
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
			backdrop-filter: blur(14px);
			-webkit-backdrop-filter: blur(14px);
			transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s, box-shadow 0.25s, background 0.25s;
			cursor: default;
			color: inherit;
		}

		.access-endpoint-card:hover {
			transform: translateY(-2px);
			border-color: rgba(168, 85, 247, 0.28);
			box-shadow: 0 12px 30px rgba(168, 85, 247, 0.08);
		}

		.endpoint-badge {
			display: inline-flex;
			align-items: center;
			padding: 4px 10px;
			border-radius: 999px;
			background: rgba(168, 85, 247, 0.12);
			color: var(--accent-color);
			font-size: 12px;
			font-weight: 600;
			letter-spacing: 0.01em;
		}

		.endpoint-url {
			display: block;
			margin-top: 12px;
			font-size: 14px;
			line-height: 1.55;
			word-break: break-all;
			color: var(--text-main);
			text-decoration: underline;
			text-decoration-color: rgba(168, 85, 247, 0.5);
			text-underline-offset: 3px;
			cursor: pointer;
			background: transparent;
			border: none;
			padding: 0;
		}

		.endpoint-url:hover {
			color: var(--accent-color);
		}

		.endpoint-hint {
			margin-top: 10px;
			font-size: 12px;
			color: var(--text-muted);
		}

		.section-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 20px;
		}

		.section-title {
			font-size: 18px;
			font-weight: 600;
			font-family: 'Outfit', sans-serif;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		/* Forms & Inputs */
		.form-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-bottom: 16px;
		}

		${SHARED_FORM_CSS}

		/* Buttons */
		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 10px 18px;
			border-radius: 10px;
			font-weight: 600;
			font-size: 14px;
			cursor: pointer;
			border: none;
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			gap: 8px;
		}

		${SHARED_BUTTON_CSS}

		.btn-success {
			background-color: var(--success-color);
			color: white;
			box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
		}

		.btn-success:hover {
			background-color: #059669;
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(16, 185, 129, 0.5);
			opacity: 0.95;
		}

		.btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
			transform: none !important;
			box-shadow: none !important;
		}

		.spinner {
			display: inline-block;
			width: 12px;
			height: 12px;
			vertical-align: text-bottom;
			border: 2px solid currentColor;
			border-right-color: transparent;
			border-radius: 50%;
			animation: spinner-border .75s linear infinite;
		}

		/* 倒计时样式 */
		.refresh-countdown {
			font-size: 11px;
			color: var(--text-muted);
			font-family: monospace;
			min-width: 28px;
			text-align: center;
			opacity: 0.7;
		}

		/* Tables */
		table {
			width: 100%;
			border-collapse: collapse;
			text-align: left;
			font-size: 14px;
		}

		th {
			background-color: var(--table-header-bg);
			font-weight: 600;
			color: var(--text-muted);
			padding: 16px 20px;
			border-bottom: 1px solid var(--border-color);
		}

		th, td {
			white-space: nowrap;
		}

		td {
			padding: 16px 20px;
			border-bottom: 1px solid var(--border-color);
			color: var(--text-main);
		}

		/* 模型映射表格：紧凑布局、列宽自适应 */
		.mappings-table { table-layout: auto; width: 100%; }
		.mappings-table th, .mappings-table td { white-space: nowrap; padding: 8px 12px; }
		.mappings-table .col-source, .mappings-table .col-target { max-width: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.mappings-table .col-op { width: auto; }
		.mappings-table-actions { display: flex; align-items: flex-end; gap: 10px; flex-wrap: nowrap; }
		.mappings-table-actions .btn { min-width: 110px; white-space: nowrap; }
		.row-tokens { display: flex; align-items: center; gap: 4px; }
		.row-tokens input { width: 65px; height: 28px; padding: 0 6px; font-size: 13px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--input-bg, transparent); color: var(--text-main); -moz-appearance: textfield; }
		.row-tokens input::-webkit-outer-spin-button, .row-tokens input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
		.row-tokens .btn { padding: 2px 8px; font-size: 12px; height: 28px; border-radius: 6px; white-space: nowrap; }

		tr:hover td {
			background-color: rgba(255, 255, 255, 0.01);
		}

		code {
			font-family: monospace;
			background-color: var(--code-bg);
			padding: 4px 8px;
			border-radius: 6px;
			font-size: 13px;
			color: var(--code-color);
			border: 1px solid var(--code-border);
			transition: all 0.2s ease;
		}

		/* Badges */
		.badge {
			display: inline-flex;
			padding: 4px 8px;
			border-radius: 6px;
			font-size: 11px;
			font-weight: 600;
			white-space: nowrap;
		}

		.badge-success { background-color: rgba(16, 185, 129, 0.15); color: #10b981; }
		.badge-warning { background-color: rgba(245, 158, 11, 0.15); color: #f59e0b; }
		.badge-danger { background-color: rgba(239, 68, 68, 0.15); color: #ef4444; }
		.badge-info { background-color: rgba(59, 130, 246, 0.15); color: #3b82f6; }

		/* Charts */
		.charts-grid {
			display: grid;
			grid-template-columns: 1.5fr 1fr;
			gap: 20px;
		}

		.chart-container {
			position: relative;
			height: 300px;
			width: 100%;
		}

		@media (max-width: 900px) {
			.charts-grid {
				grid-template-columns: 1fr;
			}
		}

		/* Modals */
		${SHARED_MODAL_CSS}

		.modal-card {
			max-width: 500px;
		}

		.modal-footer {
			display: flex;
			justify-content: flex-end;
			gap: 12px;
			border-top: 1px solid var(--border-color);
			padding-top: 20px;
			margin-top: 10px;
		}

		${SHARED_TOAST_CSS}

		/* Mobile Responsiveness */
		.mobile-header {
			display: none !important;
		}

		@media (max-width: 768px) {
			aside {
				transform: translateX(-100%);
			}
			aside.active {
				transform: translateX(0);
			}
			main {
				margin-left: 0;
				padding: 20px;
			}
			.mobile-header {
				display: flex !important;
			}
			.mobile-nav-toggle {
				background: none;
				border: none;
				color: var(--text-main);
				display: flex;
				align-items: center;
				gap: 6px;
				cursor: pointer;
				font-size: 14px;
				font-weight: 500;
			}
		}

		${SHARED_CHART_CSS}
	</style>
</head>
<body>
	
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>

	<!-- App Header for Mobile Toggle -->
	<div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background-color: var(--sidebar-bg); border-bottom: 1px solid var(--border-color); z-index: 90;" class="mobile-header">
		<div class="logo-area" style="margin-bottom: 0;">
			<div class="logo-icon">AI</div>
			<span class="logo-text">cf-ai-gw</span>
		</div>
		<div style="display: flex; align-items: center; gap: 12px;">
			<button class="mobile-nav-toggle" onclick="toggleSidebar()">
				<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
				<span>菜单</span>
			</button>
		</div>
	</div>

	<div class="app-container">
		<!-- Sidebar -->
		<aside id="sidebar">
			<div class="logo-area">
				<div class="logo-icon">AI</div>
				<span class="logo-text">cf-ai-gw</span>
			</div>
			
			<div class="nav-menu">
				<div class="nav-item active" id="menu-overview" onclick="switchTab('overview')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
					数据看板
				</div>
				
				<div class="nav-item" id="menu-keys" onclick="switchTab('keys')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg>
					API 密钥
				</div>
				<div class="nav-item" id="menu-limits" onclick="switchTab('limits')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
					限额配置
				</div>
				<div class="nav-item" id="menu-settings" onclick="switchTab('settings')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
					模型映射
				</div>
			</div>

			<div class="aside-footer">
				<button class="btn btn-secondary" onclick="toggleTheme(onAdminThemeChange)" title="切换日间/夜间模式" style="width: 100%; display: flex; justify-content: center; gap: 8px; align-items: center;">
					<svg class="theme-icon-sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none; width: 18px; height: 18px;">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
					</svg>
					<svg class="theme-icon-moon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;">
						<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
					</svg>
					<span>切换主题</span>
				</button>
				<button class="btn btn-secondary" onclick="logout()">退出登录</button>
				<div style="text-align: center; font-size: 11px; color: var(--text-muted); opacity: 0.55; padding-top: 4px;">
					由 <a href="https://github.com/ojbkxc/cf-ai-gw" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;">cf-ai-gw</a> 强力驱动
				</div>
			</div>
		</aside>

		<!-- Main Workspace -->
		<main>
			<div id="auth-views" style="display: flex; flex-direction: column; gap: 30px; width: 100%;">
				
				<!-- Header -->
				<header>
					<div>
						<h1 style="font-size: 26px; font-weight: 700;" id="view-title">数据看板</h1>
						<p style="color: var(--text-muted); font-size: 14px; margin-top: 4px;">实时监控 Cloudflare AI 账号及接口 status</p>
					</div>
					<div class="user-profile">
						<span class="badge badge-success">系统正常运行</span>
					</div>
				</header>

				<!-- TAB: Overview -->
				<div id="tab-overview" class="tab-content active">

					<!-- Account Usage Details -->
					<div class="section-card" style="padding: 30px 24px;">
						<div class="section-title" style="display: flex; align-items: center; justify-content: space-between;">
							<span>账号用量明细</span>
							<div style="display: flex; align-items: center; gap: 16px;">
								<div style="display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-muted);">
									<span>账号 <strong id="stat-accounts-count" style="font-size: 14px; color: var(--text-color);">0</strong></span>
									<span>密钥 <strong id="stat-keys-count" style="font-size: 14px; color: var(--text-color);">0</strong></span>
								</div>
								<div style="width: 1px; height: 16px; background: var(--border-color);"></div>
								<div style="display: flex; align-items: center; gap: 8px;">
									<span id="txt-last-updated" style="font-size: 11px; color: var(--text-muted); font-family: monospace; background: rgba(168, 85, 247, 0.08); padding: 2px 8px; border-radius: 8px; min-width: 28px; text-align: center;"></span>
									<button class="btn btn-secondary" id="btn-refresh-usage" onclick="loadUsageDetails(true)" style="padding: 5px 12px; font-size: 11px;">刷新</button>
								</div>
							</div>
						</div>
						<div id="accounts-usage-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(560px, 1fr)); gap: 12px; margin-top: 16px;">
						</div>
					</div>

					<div class="card-grid">
						<div class="stat-card">
							<div class="stat-title-row" style="display: flex; align-items: center; justify-content: space-between;">
								<div class="stat-title">今日用量</div>
								<span id="stat-total-requests" style="font-size: 11px; color: var(--text-muted); white-space: nowrap; background: rgba(168, 85, 247, 0.08); padding: 3px 10px; border-radius: 12px;">0</span>
							</div>
							<div style="display: flex; align-items: baseline; gap: 4px;">
								<div class="stat-value" id="stat-total-neurons" style="font-size: 42px;">0</div>
								<span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Neurons</span>
							</div>
							<div class="stat-desc" id="stat-neurons-desc" style="margin-top: auto; display: flex; justify-content: space-between; align-items: center;">
								<span>0 / <span id="stat-neurons-limit">1w</span> Neurons</span>
								<span id="stat-neurons-pct" style="font-weight: 600; color: var(--primary-color);">0%</span>
							</div>
							<div class="stat-desc" id="stat-cost-saving" style="font-size: 11px; color: #22c55e;">$0.00 节省成本</div>
						</div>

						<div class="stat-card">
							<div class="stat-title-row" style="display: flex; align-items: center; justify-content: space-between;">
								<div class="stat-title">Token 统计</div>
								<div class="stat-icon-badge" style="background: linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(16, 185, 129, 0.15)); color: var(--accent-color);">
									<svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
								</div>
							</div>
							<div style="display: flex; align-items: baseline; gap: 4px;">
								<div class="stat-value" id="stat-tokens-total" style="font-size: 36px;">0</div>
								<span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">tokens</span>
							</div>
							<div class="stat-desc" style="margin-top: 4px; font-size: 11px; color: var(--text-muted);">↑上传 <span id="stat-tokens-input">0</span></div>
							<div class="stat-desc" style="font-size: 11px; color: var(--text-muted);">↓下载 <span id="stat-tokens-output">0</span></div>
							<div class="stat-desc" id="stat-tokens-speed" style="font-size: 11px; color: var(--text-muted);">0 tok/s</div>
							<div class="stat-desc" id="stat-tokens-reasoning" style="margin-top: auto; font-size: 10px; opacity: 0.65;">推理 0 / 缓存读 0</div>
						</div>

						<div class="stat-card">
							<div class="stat-title-row" style="display: flex; align-items: center; justify-content: space-between;">
								<div class="stat-title">本月用量限额</div>
								<span id="stat-monthly-requests" style="font-size: 11px; color: var(--text-muted); white-space: nowrap; background: rgba(168, 85, 247, 0.08); padding: 3px 10px; border-radius: 12px;">0</span>
							</div>
							<div style="display: flex; align-items: baseline; gap: 4px;">
								<div class="stat-value" id="stat-monthly-usage" style="font-size: 42px;">0</div>
								<span style="font-size: 13px; color: var(--text-muted); font-weight: 500;">Neurons</span>
							</div>
							<div class="stat-desc" id="stat-monthly-desc" style="margin-top: auto; display: flex; justify-content: space-between;">
								<span>0 / 100K Neurons</span>
								<span id="stat-monthly-pct" style="font-weight: 600; color: var(--text-muted);">0%</span>
							</div>
						</div>
					</div>

					<!-- Charts -->
					<div class="charts-grid" style="margin-top: 24px;">
						<div class="section-card">
							<div class="section-title">过去 7 日消耗走势 (Neurons)</div>
							<div class="chart-container">
								<canvas id="historyChart"></canvas>
							</div>
						</div>
						<div class="section-card">
							<div class="section-title">今日模型消耗占比</div>
							<div class="chart-container public-chart-wrapper" id="admin-chart-wrapper" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 30px; height: 300px; padding: 10px 0;">
								<!-- Left: Chart -->
								<div id="admin-canvas-wrapper" style="position: relative; height: 220px; width: 220px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
									<canvas id="modelsChart"></canvas>
								</div>
								<!-- Right: Legend -->
								<div id="admin-legend-wrapper" style="flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0; align-self: stretch; height: 100%;">
									<div id="admin-chart-legend" class="chart-legend" style="flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-height: 260px; overflow-y: auto; padding-right: 4px;"></div>
								</div>
								<!-- Empty Placeholder -->
								<div id="admin-chart-placeholder" style="display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; width: 100%; color: var(--text-muted); font-size: 13px; gap: 12px; margin: auto;">
									<svg style="width: 32px; height: 32px; opacity: 0.5;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path>
									</svg>
									<span>今日暂无消耗数据</span>
								</div>
							</div>
						</div>
					</div>


				</div>

				

				<!-- TAB: API Keys -->
				<div id="tab-keys" class="tab-content">
					<!-- Proxy URL Info -->
					<div class="section-card" style="margin-bottom: 24px;">
						<div class="section-title">接入信息</div>
						<div class="section-note">OpenAI SDK、Responses（codex-cli）和 Anthropic Messages 都可直接接入，点击 URL 即可复制。</div>
						<div class="access-endpoint-grid" style="margin-top: 18px;">
							<div class="access-endpoint-card">
								<div class="endpoint-badge">OpenAI 兼容格式</div>
								<button type="button" class="endpoint-url" id="openai-endpoint-url" data-endpoint-url="" onclick="copyEndpointUrl(this.dataset.endpointUrl)">https://domain/v1/chat/completions</button>
							</div>
							<div class="access-endpoint-card">
								<div class="endpoint-badge">Responses 格式（codex-cli）</div>
								<button type="button" class="endpoint-url" id="responses-endpoint-url" data-endpoint-url="" onclick="copyEndpointUrl(this.dataset.endpointUrl)">https://domain/v1/responses</button>
							</div>
							<div class="access-endpoint-card">
								<div class="endpoint-badge">Anthropic 兼容格式</div>
								<button type="button" class="endpoint-url" id="anthropic-endpoint-url" data-endpoint-url="" onclick="copyEndpointUrl(this.dataset.endpointUrl)">https://domain/v1/messages</button>
							</div>
						</div>
					</div>

					<div class="section-card">
						<div class="section-header">
							<div class="section-title">API 密钥管理</div>
							<button class="btn btn-primary" onclick="openAddKeyModal()">
								<svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
								生成新密钥
							</button>
						</div>
						
						<div style="background-color: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.2); padding: 16px; border-radius: 12px; font-size: 13px; color: var(--warning-color); line-height: 1.5; margin-bottom: 10px;" id="no-key-warning" class="hidden">
							<strong>提示：</strong> 目前未配置任何 API 密钥。反代 API (/v1/...) 处于公开可被任何人调用的状态。建议点击“生成新密钥”为您的接口加上调用凭证鉴权。
						</div>

						<table>
							<thead>
								<tr>
									<th>密钥描述</th>
									<th>API Key</th>
									<th>创建时间</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody id="keys-table-body">
								<!-- Keys rows -->
							</tbody>
						</table>
					</div>
				</div>

				<!-- TAB: Settings (Model Mapping) -->
				<div id="tab-settings" class="tab-content">
					<div class="section-card">
						<div class="section-title">模型映射 (Model Mappings)</div>
						<p style="font-size: 13px; color: var(--text-muted); margin-top: 8px; margin-bottom: 20px; line-height: 1.6;">将客户端请求的模型名映射到 Cloudflare AI 模型。@cf/ 开头直接透传。</p>
						
						<div style="display: grid; grid-template-columns: 1fr 1.5fr auto; gap: 15px; background-color: var(--section-item-bg); padding: 20px; border-radius: 12px; border: 1px solid var(--border-color); margin-top: 10px;">
							<div class="form-group" style="margin-bottom: 0;">
								<label>请求模型</label>
								<input type="text" id="map-source" placeholder="如: gpt-3.5-turbo">
							</div>
							<div class="form-group" style="margin-bottom: 0;">
								<label>目标模型</label>
								<input type="text" id="map-target" placeholder="如: @cf/meta/llama-3.1-8b-instruct">
							</div>
							<div class="form-group" style="margin-bottom: 0;">
								<label>Tokens 上限</label>
								<input type="number" id="map-tokens" placeholder="留空使用默认值" min="1" step="1">
							</div>
							<div class="mappings-table-actions">
								<button class="btn btn-primary" onclick="addMapping()" style="height: 45px;">添加/修改</button>
								<button class="btn btn-secondary" onclick="restorePresetMappings()" style="height: 45px;">预设映射</button>
								<button class="btn btn-secondary" onclick="fetchFreeModels()" style="height: 45px;">获取免费模型</button>
							</div>
						</div>

						<table class="mappings-table" style="margin-top: 20px;">
							<thead>
								<tr>
									<th>请求模型</th>
									<th>目标模型</th>
									<th>Tokens</th>
									<th>类型</th>
									<th class="col-op">操作</th>
								</tr>
							</thead>
							<tbody id="mappings-table-body">
								<!-- Mapping rows -->
							</tbody>
						</table>
					</div>
				</div>

				<div id="tab-limits" class="tab-content">
					<div class="section-card">
						<div class="section-title">用量限额配置</div>
						<p style="font-size: 13px; color: var(--text-muted); margin-top: 8px; margin-bottom: 20px; line-height: 1.6;">
							配置每日/每月用量限额和拦截阈值。阈值设为 0 表示关闭限额拦截（仅统计不拦截）。<br>
							环境变量 <code>DAILY_LIMIT</code>、<code>MONTHLY_LIMIT</code>、<code>USAGE_THRESHOLD</code> 优先级高于此处配置。
						</p>

						<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 20px;">
							<div class="form-group" style="margin-bottom: 0;">
								<label>每日限额 (Neurons)</label>
								<input type="number" id="limits-daily" min="0" step="1" placeholder="10000">
							</div>
							<div class="form-group" style="margin-bottom: 0;">
								<label>每月限额 (Neurons)</label>
								<input type="number" id="limits-monthly" min="0" step="1" placeholder="100000">
							</div>
							<div class="form-group" style="margin-bottom: 0;">
								<label>拦截阈值 (0-1)</label>
								<input type="number" id="limits-threshold" min="0" max="1" step="0.05" placeholder="0.9">
								<span style="font-size: 11px; color: var(--text-muted);">0 = 关闭限额拦截</span>
							</div>
						</div>

						<button class="btn btn-primary" onclick="saveLimits()" style="align-self: flex-start;">保存配置</button>
						<span id="limits-save-msg" style="font-size: 13px; margin-left: 12px; display: none;"></span>
					</div>

					<div class="section-card" style="margin-top: 20px;">
						<div class="section-title">环境变量说明</div>
						<p style="font-size: 13px; color: var(--text-muted); line-height: 1.8; margin-top: 8px;">
							以下配置优先级：<strong>环境变量 > 面板配置 > 默认值</strong><br><br>
							<code>DAILY_LIMIT</code> — 每日 Neurons 限额（默认 10000）<br>
							<code>MONTHLY_LIMIT</code> — 每月 Neurons 限额（默认 100000）<br>
							<code>USAGE_THRESHOLD</code> — 拦截阈值（0-1，默认 0，即关闭拦截）<br><br>
							在 Cloudflare Workers 仪表盘的 Settings → Variables 中添加上述环境变量即可覆盖面板配置。
						</p>
					</div>
				</div>

			</div>
		</main>
	</div>

	<!-- Modal: Add API Key -->
	<div class="modal-overlay" id="key-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3 id="key-modal-title">生成新 API 密钥</h3>
				<button onclick="closeKeyModal()" class="close-btn">${SVG_CLOSE}</button>
			</div>
			<div id="key-modal-form">
				<div class="form-group" style="margin-bottom: 16px;">
					<label for="key-name">密钥描述/使用客户端 (如: Cursor / NextChat)</label>
					<input type="text" id="key-name" placeholder="请输入描述名" style="width: 100%;">
				</div>
				<div class="form-group" style="margin-bottom: 16px;">
					<label for="key-val">API 密钥值 (可选，为空则随机生成 sk-wa-...)</label>
					<input type="text" id="key-val" placeholder="留空则随机生成密钥" style="width: 100%;">
				</div>
				<div class="modal-footer" style="margin-top: 10px; display: flex; gap: 12px; justify-content: flex-end; width: 100%;">
					<button class="btn btn-secondary" onclick="closeKeyModal()">取消</button>
					<button class="btn btn-primary" onclick="saveKey()">生成密钥</button>
				</div>
			</div>
			<div id="key-modal-success" class="hidden" style="display: flex; flex-direction: column; gap: 16px;">
				<div style="text-align: center; color: var(--success-color); font-size: 40px; margin-bottom: 8px;">🎉</div>
				<p style="font-size: 14px; text-align: center; line-height: 1.6; color: var(--text-main);">
					密钥生成成功！请务必复制保存此密钥，关闭后将无法再次完整查看。
				</p>
				<div class="form-group">
					<label>API Key</label>
					<div style="display: flex; gap: 10px;">
						<input type="text" id="generated-key-val" readonly style="flex: 1; font-family: monospace;">
						<button class="btn btn-primary" onclick="copyGeneratedKey()">复制</button>
					</div>
				</div>
				<div class="modal-footer" style="margin-top: 10px; width: 100%;">
					<button class="btn btn-secondary" onclick="closeKeyModal()" style="width: 100%;">我已保存，关闭</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Modal: Select Free Model -->
	<div class="modal-overlay" id="model-select-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3>选择 @cf/ 免费模型</h3>
				<button onclick="document.getElementById('model-select-modal').classList.remove('active')" class="close-btn">${SVG_CLOSE}</button>
			</div>
			<div style="margin-bottom: 12px; font-size: 13px; color: var(--text-muted);">点击模型自动新增映射：左侧为简称，右侧为完整路径</div>
			<div style="margin-bottom: 10px;">
				<input type="text" id="model-search-input" placeholder="搜索模型..." oninput="filterModelList()"
					   style="width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; box-sizing: border-box;">
			</div>
			<div id="model-select-list" style="flex: 1; min-height: 0; max-height: 55vh; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 8px;">
				<div style="text-align: center; padding: 30px; color: var(--text-muted);">加载中...</div>
			</div>
			<div class="modal-footer">
				<button class="btn btn-secondary" onclick="document.getElementById('model-select-modal').classList.remove('active')">关闭</button>
			</div>
		</div>
	</div>

	<script>
		${SHARED_JS}

		function fmtTok(n) {
			if (n < 1000) return String(n);
			if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
			if (n < 1000000000) return (n / 1000000).toFixed(2).replace(/\.?0+$/, '') + 'M';
			return (n / 1000000000).toFixed(2).replace(/\.?0+$/, '') + 'B';
		}

		let currentTab = 'overview';
		let historyChart = null;
		let modelsChart = null;
		const defaultMappings = ${JSON.stringify(DEFAULT_MODEL_MAP)};
		const defaultTokens = ${JSON.stringify(DEFAULT_MODEL_TOKENS)};
		let customMappings = {};
		let modelTokensConfig = {};

		function renderUsageDetails(data) {
			// localStorage 向后兼容：旧格式是数组，新格式是 { accounts, limits }
			if (Array.isArray(data)) {
				data = { accounts: data, limits: { dailyUsage: 0, dailyRequests: 0, dailyLimit: 10000, monthlyUsage: 0, monthlyRequests: 0, monthlyLimit: 100000, threshold: 0.9 } };
			}
			const { accounts, limits } = data;

			let totalUsageToday = 0;
			let totalRequestsToday = 0;
			const totalLimit = limits.dailyLimit;
			let historyData = {};
			let modelsToday = {};

			const usageList = document.getElementById('accounts-usage-list');

			// 增量更新：复用已有卡片，避免 innerHTML='' 导致全量闪烁
			const existingCards = new Map();
			usageList.querySelectorAll('[data-account-id]').forEach(card => {
				existingCards.set(card.dataset.accountId, card);
			});
			const newAccountIds = new Set();

			if (accounts.length === 0) {
				usageList.innerHTML = '<div style="color: var(--text-muted); font-size:14px; text-align:center; padding: 20px; width: 100%;">暂无账号数据。模式 A 用量数据来自模式 B 面板配置的账号（共用 KV）；仅部署模式 A 时看板显示空数据。</div>';
				updateLimitCards(limits);
				return;
			}

			accounts.forEach(account => {
				totalUsageToday += account.usageToday;
				totalRequestsToday += account.usageTodayRequests || 0;

			const percentage = limits.dailyLimit > 0 ? Number(((account.usageToday / limits.dailyLimit) * 100).toFixed(2)) : 0;
				// ≥100% 红色，≥90% 橙色，其余绿色
				const level = percentage >= 100 ? 'danger' : (percentage >= 90 ? 'warn' : 'ok');
				const warningClass = account.status === 'error' ? 'badge-danger' : (account.status === 'pending' ? 'badge-info' : (level === 'danger' ? 'badge-danger' : (level === 'warn' ? 'badge-warning' : 'badge-success')));
				const statusText = account.status === 'error' ? '连接异常' : (account.status === 'pending' ? '待刷新' : (percentage >= 100 ? '已用尽' : '正常运行'));
				const roundedUsage = Math.ceil(account.usageToday);
				newAccountIds.add(account.id);

				// 7天历史总量
				const history7d = (account.history || []).reduce((sum, h) => sum + (h.neurons || 0), 0);
				// 本月用量（从 history 中提取当月）
				const now = new Date();
				const monthPrefix = now.toISOString().slice(0, 7); // "YYYY-MM"
				const monthUsage = (account.history || []).filter(h => h.date && h.date.startsWith(monthPrefix)).reduce((sum, h) => sum + (h.neurons || 0), 0);
				// 模型数量
				const modelCount = (account.modelsToday || []).length;
				// 7天请求次数
				const requests7d = (account.history || []).reduce((sum, h) => sum + (h.requests || 0), 0);
				// 账号ID 短格式
				const shortId = account.accountId.length > 14
					? account.accountId.substring(0, 8) + '...' + account.accountId.substring(account.accountId.length - 4)
					: account.accountId;

				let item = existingCards.get(account.id);
				const isRefreshed = item && parseInt(item.dataset.lastUpdated || '0', 10) !== (account.lastUpdated || 0);

				if (!item) {
					item = document.createElement('div');
					item.dataset.accountId = account.id;
					item.style.padding = '16px 20px';
					item.style.borderRadius = '14px';
					item.style.border = '1px solid var(--border-color)';
					item.style.backgroundColor = 'var(--card-bg)';
					item.style.backdropFilter = 'blur(var(--glass-blur))';
					usageList.appendChild(item);
				} else {
					item.className = '';
					void item.offsetHeight;
				}
				if (isRefreshed) item.classList.add('refreshed');
				item.dataset.lastUpdated = account.lastUpdated || 0;
				item.innerHTML = \`
					<div style="display:flex; justify-content:space-between; align-items:center; gap: 12px; margin-bottom: 10px;">
						<div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px;">
							<strong style="font-size:14px; font-weight:600; word-break: break-all; flex: 1 1 auto; min-width: 0;" title="\${escapeHtml(account.name)}">\${escapeHtml(account.name)}</strong>
							<span style="font-size:10px; color: var(--text-muted); font-family: monospace; white-space: nowrap; flex-shrink: 0;">\${escapeHtml(shortId)}</span>
						</div>
						<span class="badge \${warningClass}" style="flex-shrink: 0; font-size: 10px; padding: 3px 8px;">\${statusText} · \${percentage.toFixed(2)}%</span>
					</div>
					<div class="usage-progress-container">
						<div class="usage-progress-bar" style="width: \${Math.min(100, percentage)}%;"></div>
					</div>
					<div style="display:grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px 12px; font-size:11px; color: var(--text-muted); margin-top: 10px;">
						<div><span style="opacity:0.6;">今日</span><br><strong style="color: var(--text-color); font-size: 13px;">\${fmtTok(roundedUsage)}</strong> <span style="opacity:0.5;">Neurons</span></div>
						<div><span style="opacity:0.6;">今日请求</span><br><strong style="color: var(--text-color); font-size: 13px;">\${(account.usageTodayRequests || 0).toLocaleString()}</strong></div>
						<div><span style="opacity:0.6;">7日总量</span><br><strong style="color: var(--text-color); font-size: 13px;">\${fmtTok(history7d)}</strong> <span style="opacity:0.5;">Neurons</span></div>
						<div><span style="opacity:0.6;">7日请求</span><br><strong style="color: var(--text-color); font-size: 13px;">\${requests7d.toLocaleString()}</strong></div>
						<div><span style="opacity:0.6;">本月用量</span><br><strong style="color: var(--text-color); font-size: 13px;">\${fmtTok(monthUsage)}</strong> <span style="opacity:0.5;">Neurons</span></div>
						<div><span style="opacity:0.6;">日限额</span><br><strong style="color: var(--text-color); font-size: 13px;">\${fmtTok(limits.dailyLimit)}</strong> <span style="opacity:0.5;">Neurons</span></div>
						<div><span style="opacity:0.6;">模型数</span><br><strong style="color: var(--text-color); font-size: 13px;">\${modelCount}</strong></div>
						<div><span style="opacity:0.6;">状态</span><br><strong style="color: \${level === 'danger' ? '#ef4444' : (level === 'warn' ? '#f59e0b' : '#22c55e')}; font-size: 13px;">\${statusText}</strong></div>
					</div>
					\${account.error ? \`<div style="color: var(--danger-color); font-size:11px; margin-top: 8px; background: rgba(239,68,68,0.08); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(239,68,68,0.12);">错误信息: \${escapeHtml(account.error)}</div>\` : ''}
				\`;

				if (account.history) {
					account.history.forEach(h => {
						historyData[h.date] = (historyData[h.date] || 0) + h.neurons;
					});
				}

				if (account.modelsToday) {
					account.modelsToday.forEach(m => {
						modelsToday[m.model] = (modelsToday[m.model] || 0) + m.neurons;
					});
				}
			});

			// 清理已不存在的账号卡片
			existingCards.forEach((card, id) => {
				if (!newAccountIds.has(id)) card.remove();
			});

			// Top stats formatting
			const roundedTotalUsageToday = Math.ceil(totalUsageToday);
			document.getElementById('stat-total-neurons').innerText = fmtTok(roundedTotalUsageToday);
			document.getElementById('stat-accounts-count').innerText = accounts.length;
			document.getElementById('stat-total-requests').innerText = totalRequestsToday.toLocaleString();
			
			const overallPercentage = totalLimit > 0 ? Number(((totalUsageToday / totalLimit) * 100).toFixed(2)) : 0;
			const neuronsDesc = document.getElementById('stat-neurons-desc');
			if (neuronsDesc) {
				const leftSpan = neuronsDesc.querySelector('span:first-child');
				const rightSpan = neuronsDesc.querySelector('#stat-neurons-pct');
				if (leftSpan) {
					leftSpan.innerHTML = fmtTok(roundedTotalUsageToday) + ' / ' + fmtTok(totalLimit) + ' Neurons';
				}
				if (rightSpan) {
					const pctText = overallPercentage > 100 ? '+' + (overallPercentage - 100).toFixed(2) + '%' : overallPercentage.toFixed(2) + '%';
					rightSpan.innerText = pctText;
					rightSpan.style.color = overallPercentage > 100 ? '#ef4444' : 'var(--primary-color)';
				}
			}
			
			const costSaved = (totalUsageToday / 1000) * 0.011;
			document.getElementById('stat-cost-saving').innerText = '$' + costSaved.toFixed(2) + ' 节省成本';

			updateLimitCards(limits);

			const dates = Object.keys(historyData).sort();
			const neuronsData = dates.map(d => historyData[d]);
			renderHistoryChart(dates, neuronsData);

			const models = Object.keys(modelsToday);
			const modelsNeurons = models.map(m => modelsToday[m]);
			renderModelsChart(models, modelsNeurons);
		}

		function updateLimitCards(limits) {
			const { monthlyUsage = 0, monthlyRequests = 0, monthlyLimit = 100000, threshold = 0.9 } = limits || {};
			const limitDisabled = threshold <= 0;

			// 本月限额
		const monthlyPct = monthlyLimit > 0 ? Number(((monthlyUsage / monthlyLimit) * 100).toFixed(2)) : 0;
		document.getElementById('stat-monthly-usage').innerText = fmtTok(Math.ceil(monthlyUsage));
		const monthlyDesc = document.getElementById('stat-monthly-desc');
		if (monthlyDesc) {
			const leftSpan = monthlyDesc.querySelector('span:first-child');
			const rightSpan = monthlyDesc.querySelector('#stat-monthly-pct');
			if (leftSpan) {
				leftSpan.innerText = limitDisabled
					? fmtTok(Math.ceil(monthlyUsage)) + ' Neurons · 限额关闭'
					: fmtTok(Math.ceil(monthlyUsage)) + ' / ' + fmtTok(monthlyLimit) + ' Neurons';
			}
			if (rightSpan) {
				if (limitDisabled) {
					rightSpan.style.display = 'none';
				} else {
					rightSpan.style.display = '';
					rightSpan.innerText = monthlyPct.toFixed(1) + '%';
					rightSpan.style.color = '';
				}
			}
		}
			document.getElementById('stat-monthly-requests').innerText = monthlyRequests.toLocaleString();
			
		}

		let isRefreshingUsage = false;
		async function loadTokenStats() {
			try {
				const res = await fetch("/api/tokens/today");
				if (!res.ok) return;
				const data = await res.json();
				const totalEl = document.getElementById("stat-tokens-total");
				if (totalEl) totalEl.innerText = data.totalFmt || "0";
				const inputEl = document.getElementById("stat-tokens-input");
				if (inputEl) inputEl.innerText = data.inputFmt || "0";
				const outputEl = document.getElementById("stat-tokens-output");
				if (outputEl) outputEl.innerText = data.outputFmt || "0";
				const speedEl = document.getElementById("stat-tokens-speed");
				if (speedEl) speedEl.innerText = (data.avgTokPerSec || 0) + " tok/s";
				const reasoningEl = document.getElementById("stat-tokens-reasoning");
			if (reasoningEl) {
				const reasoningVal = data.reasoningFmt || "0";
				const cacheReadVal = data.cacheReadFmt || "0";
				if (reasoningVal === "0" && cacheReadVal === "0") {
					reasoningEl.style.display = "none";
				} else {
					reasoningEl.style.display = "";
					reasoningEl.innerText = "推理 " + reasoningVal + " / 缓存读 " + cacheReadVal;
				}
			}
			} catch (e) { console.error("Failed to load token stats:", e); }
		}


		let refreshTimer = null;

		async function loadUsageDetails(isManual = false) {
			if (isRefreshingUsage) return;

			const now = Date.now();
			const lastFetchedRaw = localStorage.getItem('cache_usage_details_last_fetched');
			let lastFetched = lastFetchedRaw ? parseInt(lastFetchedRaw, 10) : 0;

			// 优先从浏览器 localStorage 读取并渲染上次缓存的数据
			const cachedDataRaw = localStorage.getItem('cache_accounts_usage');
			if (cachedDataRaw) {
				try {
					const cachedData = JSON.parse(cachedDataRaw);
					renderUsageDetails(cachedData);
				} catch (e) {
					console.error('Error parsing cached usage details:', e);
				}
			}
			const cachedKeysCount = localStorage.getItem('cache_keys_count');
			if (cachedKeysCount) {
				document.getElementById('stat-keys-count').innerText = cachedKeysCount;
			}

			// 更新文字显示
			updateLastUpdatedText(lastFetched);

			// 防抖：距上次刷新不到 60s 则跳过（手动刷新除外）
			if (!isManual && lastFetched && (now - lastFetched) < 60000) {
				return;
			}

			const btn = document.getElementById('btn-refresh-usage');
			let originalBtnText = '';
			if (btn) {
				originalBtnText = btn.innerHTML;
				btn.disabled = true;
				btn.innerHTML = '<span class="spinner"></span> 刷新中...';
			}

			isRefreshingUsage = true;

			try {
				// 并行请求账号用量和 API 密钥数
				const [usageRes, keysRes] = await Promise.all([
					apiFetch('/api/accounts/usage'),
					apiFetch('/api/keys')
				]);
				const data = await usageRes.json();
				const keys = await keysRes.json();

				// 渲染最新的实时数据
				renderUsageDetails(data);
				document.getElementById('stat-keys-count').innerText = keys.length;

				// 保存/更新本地缓存
				localStorage.setItem('cache_accounts_usage', JSON.stringify(data));
				localStorage.setItem('cache_keys_count', keys.length);
				localStorage.setItem('cache_usage_details_last_fetched', now);
				updateLastUpdatedText(now);

			} catch (e) {
				console.error(e);
			} finally {
				isRefreshingUsage = false;
				if (btn) {
					btn.disabled = false;
					btn.innerHTML = originalBtnText;
				}
			}
		}

		function updateLastUpdatedText(timestamp) {
			const label = document.getElementById('txt-last-updated');
			if (!label) return;
			if (!timestamp) {
				label.innerText = '';
				label.style.display = 'none';
				return;
			}
			const diff = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
			let text;
			if (diff < 10) text = 'now';
			else if (diff < 60) text = diff + 's';
			else if (diff < 3600) text = Math.floor(diff / 60) + 'm';
			else if (diff < 86400) text = Math.floor(diff / 3600) + 'h';
			else text = Math.floor(diff / 86400) + 'd';
			label.innerText = text;
		}

		function onAdminThemeChange() {
			if (currentTab === 'overview') loadUsageDetails();
			loadTokenStats();
		}

		initTheme();

		window.onload = function() {
			const openaiUrl = window.location.origin + '/v1/chat/completions';
			const responsesUrl = window.location.origin + '/v1/responses';
			const anthropicUrl = window.location.origin + '/v1/messages';
			const openaiUrlEl = document.getElementById('openai-endpoint-url');
			const responsesUrlEl = document.getElementById('responses-endpoint-url');
			const anthropicUrlEl = document.getElementById('anthropic-endpoint-url');
			if (openaiUrlEl) {
				openaiUrlEl.dataset.endpointUrl = openaiUrl;
				openaiUrlEl.textContent = openaiUrl;
			}
			if (responsesUrlEl) {
				responsesUrlEl.dataset.endpointUrl = responsesUrl;
				responsesUrlEl.textContent = responsesUrl;
			}
			if (anthropicUrlEl) {
				anthropicUrlEl.dataset.endpointUrl = anthropicUrl;
				anthropicUrlEl.textContent = anthropicUrl;
			}
			loadUsageDetails();
			loadTokenStats();
			// 每秒更新"距上次刷新"的相对时间，并在每天 0:03 触发自动刷新
			let _midnightRefreshed = false;
			refreshTimer = setInterval(() => {
				const lastFetchedRaw = localStorage.getItem('cache_usage_details_last_fetched');
				const lastFetched = lastFetchedRaw ? parseInt(lastFetchedRaw, 10) : 0;
				if (lastFetched) {
					updateLastUpdatedText(lastFetched);
				}
				// 每天 UTC 0:02~0:05 之间强制刷新（跨天数据重置）
				const h = new Date().getUTCHours();
				const m = new Date().getUTCMinutes();
				if (h === 0 && m >= 2 && m <= 5) {
					if (!_midnightRefreshed) {
						_midnightRefreshed = true;
						loadUsageDetails(true);
						loadTokenStats();
					}
				} else {
					_midnightRefreshed = false;
				}
			}, 1000);
		};

		function toggleSidebar() {
			document.getElementById('sidebar').classList.toggle('active');
		}

		async function logout() {
			const res = await fetch('/api/auth/logout', { method: 'POST' });
			if (res.ok) {
				showToast('已安全退出登录');
				setTimeout(() => {
					window.location.href = '/';
				}, 800);
			}
		}

		function switchTab(tabName) {
			if (tabName === currentTab) return;
			currentTab = tabName;
			document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
			document.getElementById('menu-' + tabName).classList.add('active');

			document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
			document.getElementById('tab-' + tabName).classList.add('active');

			const titles = {
				overview: '数据看板',
				keys: 'API 密钥',
				limits: '限额配置',
				settings: '模型映射'
			};
			document.getElementById('view-title').innerText = titles[tabName];
			document.getElementById('sidebar').classList.remove('active');

			if (tabName === 'overview') {
				loadUsageDetails();
				loadTokenStats();
			} else if (tabName === 'keys') {
				loadKeys();
			} else if (tabName === 'limits') {
				loadLimits();
			} else if (tabName === 'settings') {
				loadSettings();
			}
		}

		async function apiFetch(path, options = {}) {
			// 对 POST/PUT/PATCH/DELETE 请求自动附加 CSRF Token（从 meta 标签读取）
			const method = (options.method || 'GET').toUpperCase();
			if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
				const csrfMeta = document.querySelector('meta[name="csrf-token"]');
				if (csrfMeta) {
					options.headers = { ...options.headers, 'X-CSRF-Token': csrfMeta.getAttribute('content') };
				}
			}
			const res = await fetch(path, options);
			if (res.status === 401) {
				window.location.href = '/';
				throw new Error('Unauthorized');
			}
			return res;
		}


		function renderHistoryChart(labels, data) {
			if (historyChart) historyChart.destroy();
			const isLight = document.documentElement.getAttribute('data-theme') === 'light';
			const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
			const textColor = isLight ? '#64748b' : '#94a3b8';
			const ctx = document.getElementById('historyChart').getContext('2d');
			const gradient = ctx.createLinearGradient(0, 0, 0, 300);
			gradient.addColorStop(0, 'rgba(168, 85, 247, 0.35)');
			gradient.addColorStop(1, 'rgba(168, 85, 247, 0.00)');
			historyChart = new Chart(ctx, {
				type: 'line',
				data: {
					labels: labels,
					datasets: [{
						label: 'Neuron 消耗数',
						data: data,
						borderColor: '#a855f7',
						backgroundColor: gradient,
						borderWidth: 3,
						tension: 0.3,
						fill: true,
						pointBackgroundColor: '#a855f7',
						pointBorderColor: 'rgba(255, 255, 255, 0.8)',
						pointBorderWidth: 1.5,
						pointRadius: 4,
						pointHoverRadius: 6,
						pointHoverBorderWidth: 3
					}]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: { legend: { display: false } },
					scales: {
						y: {
							grid: { color: gridColor },
							ticks: {
								color: textColor,
								callback: function(value) { return fmtTok(value); }
							}
						},
						x: {
							grid: { display: false },
							ticks: {
								color: textColor,
								maxTicksLimit: 7,
								callback: function(value, index) {
									const d = new Date(labels[index]);
									const month = String(d.getMonth() + 1).padStart(2, '0');
									const day = String(d.getDate()).padStart(2, '0');
									return month + '/' + day;
								}
							}
						}
					}
				}
			});
		}

		function renderModelsChart(labels, data) {
			if (modelsChart) modelsChart.destroy();
			
			const legendContainer = document.getElementById('admin-chart-legend');
			const canvasWrapper = document.getElementById('admin-canvas-wrapper');
			const legendWrapper = document.getElementById('admin-legend-wrapper');
			const placeholder = document.getElementById('admin-chart-placeholder');

			if (legendContainer) legendContainer.innerHTML = '';

			if (labels.length === 0) {
				if (canvasWrapper) canvasWrapper.style.display = 'none';
				if (legendWrapper) legendWrapper.style.display = 'none';
				if (placeholder) placeholder.style.display = 'flex';
				return;
			} else {
				if (canvasWrapper) canvasWrapper.style.display = 'flex';
				if (legendWrapper) legendWrapper.style.display = 'flex';
				if (placeholder) placeholder.style.display = 'none';
			}

			// Sort the model data descending by neurons
			const combined = labels.map((label, idx) => ({
				fullLabel: label,
				cleanLabel: label.split('/').pop(),
				value: data[idx]
			})).sort((a, b) => b.value - a.value);

			const sortedLabels = combined.map(x => x.cleanLabel);
			const sortedData = combined.map(x => x.value);

			const isLight = document.documentElement.getAttribute('data-theme') === 'light';
			const borderColor = isLight ? '#ffffff' : '#1e293b';
			
			if (modelsChart) modelsChart.destroy();
			modelsChart = createDoughnutChart('modelsChart', sortedLabels, sortedData, borderColor);

			// Render Custom HTML Legend for Admin Page
			renderChartLegend(legendContainer, sortedLabels, sortedData, combined.map(x => x.fullLabel));
		}

		async function copyEndpointUrl(url) {
			if (!url) return;
			await copyText(url, '已复制接入地址！');
		}

		// 通用表格数据加载函数
		async function loadTableData(url, tbodyId, emptyMsg, renderFn, onEmpty) {
			try {
				const res = await apiFetch(url);
				const items = await res.json();
				const tbody = document.getElementById(tbodyId);
				tbody.innerHTML = '';
				if (items.length === 0) {
					tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color: var(--text-muted); padding: 30px;">' + emptyMsg + '</td></tr>';
					if (onEmpty) onEmpty();
					return;
				}
				if (onEmpty) onEmpty(items.length > 0);
				items.forEach(item => {
					const tr = document.createElement('tr');
					tr.innerHTML = renderFn(item);
					tbody.appendChild(tr);
				});
			} catch (e) {
				console.error(e);
			}
		}

		async function loadKeys() {
			await loadTableData('/api/keys', 'keys-table-body', '暂无配置的 API 密钥', (k) => {
				const dateStr = new Date(k.createdAt).toLocaleString();
				return \`
					<td><strong style="font-weight:600;">\${escapeHtml(k.name)}</strong></td>
					<td>
						<div style="display:flex; align-items:center; gap:8px;">
							<code id="key-val-\${k.id}">\${escapeHtml(k.key.length > 6 ? k.key.substring(0, 5) + '...' + k.key.substring(k.key.length - 1) : k.key.substring(0, Math.min(3, k.key.length)) + '...')}</code>
							<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px; border-radius:6px;" onclick="copyKeyText(\${attrEscape(k.key)})">复制</button>
						</div>
					</td>
					<td>\${dateStr}</td>
					<td>
						<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; border-radius:6px; color: var(--danger-color);" onclick="deleteKey(\${attrEscape(k.id)})">删除</button>
					</td>
				\`;
			}, (hasData) => {
				const el = document.getElementById('no-key-warning');
				if (el) el.classList.toggle('hidden', !!hasData);
			});
		}

		async function copyKeyText(val) {
			await copyText(val, 'API Key 复制成功！');
		}

		function openAddKeyModal() {
			document.getElementById('key-name').value = '';
			document.getElementById('key-val').value = '';
			document.getElementById('key-modal-title').innerText = '生成新 API 密钥';
			document.getElementById('key-modal-form').classList.remove('hidden');
			document.getElementById('key-modal-success').classList.add('hidden');
			document.getElementById('key-modal').classList.add('active');
		}

		function closeKeyModal() {
			document.getElementById('key-modal').classList.remove('active');
		}

		async function saveKey() {
			const name = document.getElementById('key-name').value;
			const key = document.getElementById('key-val').value;
			if (!name) {
				showToast('请输入描述名称！', 'warning');
				return;
			}
			const res = await apiFetch('/api/keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, key })
			});
			if (res.ok) {
				const data = await res.json();
				loadKeys();
				document.getElementById('key-modal-title').innerText = '密钥已生成';
				document.getElementById('key-modal-form').classList.add('hidden');
				document.getElementById('key-modal-success').classList.remove('hidden');
				document.getElementById('generated-key-val').value = data.key;
			} else {
				showToast('保存密钥失败！', 'error');
			}
		}

		async function copyGeneratedKey() {
			await copyText(document.getElementById('generated-key-val').value, 'API Key 复制成功！');
		}

		async function deleteKey(id) {
			if (!confirm('确定要删除这个 API 密钥吗？')) return;
			await deleteResource('/api/keys/', id, loadKeys, '密钥已成功删除', '删除密钥失败');
		}

		async function copyModelId(val) {
			if (typeof val === 'string' && val.length >= 2 && val.charCodeAt(0) === 0x22 && val.charCodeAt(val.length - 1) === 0x22) {
				val = val.slice(1, -1);
			}
			await copyText(val, \`已复制模型: \${val}\`);
		}

		async function loadSettings() {
			try {
				const res = await apiFetch('/api/settings');
				const data = await res.json();
				customMappings = data.customModelMap || {};
				modelTokensConfig = data.modelTokens || {};
				const items = Object.keys(customMappings).map(source => ({ source, target: customMappings[source] }));
				items.sort((a, b) => {
					const ta = modelTokensConfig[a.target] !== undefined ? modelTokensConfig[a.target] : (defaultTokens[a.target] || 0);
					const tb = modelTokensConfig[b.target] !== undefined ? modelTokensConfig[b.target] : (defaultTokens[b.target] || 0);
					return tb - ta;
				});
				const tbody = document.getElementById('mappings-table-body');
				tbody.innerHTML = '';
				if (items.length === 0) {
					tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 30px;">暂无模型映射</td></tr>';
					return;
				}
				items.forEach(({ source, target }) => {
					const isPreset = Object.prototype.hasOwnProperty.call(defaultMappings, source) && defaultMappings[source] === target;
					const typeText = isPreset ? '<span class="badge badge-success">预设映射</span>' : '<span class="badge badge-warning">自定义</span>';
					// Tokens 生效值：自定义 > 预设 > 无
					const tokenVal = modelTokensConfig[target] !== undefined ? modelTokensConfig[target] : defaultTokens[target];
					const defaultVal = defaultTokens[target];
					// 输入框显示当前生效值，留空则回退默认
					const showVal = modelTokensConfig[target] !== undefined ? modelTokensConfig[target] : (tokenVal || '');
					const tokensPlaceholder = defaultVal ? '默认 ' + defaultVal.toLocaleString() : '默认';
					const tr = document.createElement('tr');
					tr.innerHTML = \`
					<td class="col-source"><code style="cursor: pointer; word-break: break-all;" title="点击复制" onclick="copyModelId(\${attrEscape(source)})">\${escapeHtml(source)}</code></td>
					<td class="col-target"><code style="cursor: pointer; word-break: break-all;" title="点击复制" onclick="copyModelId(\${attrEscape(target)})">\${escapeHtml(target)}</code></td>
					<td>
						<div class="row-tokens">
							<input type="number" min="1" step="1" value="\${showVal ? showVal : ''}" placeholder="\${tokensPlaceholder}" data-target="\${attrEscape(target)}" onchange="saveRowTokens(this)">
							<button class="btn btn-secondary" onclick="saveRowTokens(this.previousElementSibling)">保存</button>
						</div>
					</td>
					<td>\${typeText}</td>
					<td class="col-op">
						<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; border-radius:6px; color: var(--danger-color);" onclick="deleteMapping(\${attrEscape(source)})">删除</button>
					</td>
					\`;
					tbody.appendChild(tr);
				});
			} catch(e) {
				console.error(e);
			}
		}

		// 单独保存某一行的 Tokens 配置（按目标模型 target）
		async function saveRowTokens(input) {
			if (!input) return;
			const target = input.getAttribute('data-target');
			if (!target) return;
			const val = input.value.trim();
			const next = { ...modelTokensConfig };
			if (val) {
				const tokensNum = parseInt(val, 10);
				if (isNaN(tokensNum) || tokensNum <= 0) {
					showToast('Tokens 上限必须为正整数', 'warning');
					const cur = modelTokensConfig[target] !== undefined ? modelTokensConfig[target] : defaultTokens[target];
					input.value = cur ? cur : '';
					return;
				}
				next[target] = tokensNum;
			} else {
				delete next[target];
			}
			const res = await apiFetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ modelTokens: next })
			});
			if (res.ok) {
				modelTokensConfig = next;
				loadSettings();
				showToast('Tokens 已保存');
			} else {
				showToast('保存 Tokens 失败！', 'error');
			}
		}

		async function addMapping() {
			const source = document.getElementById('map-source').value.trim();
			const target = document.getElementById('map-target').value.trim();
			if (!source || !target) {
				showToast('请求模型名称和目标模型路径不能为空！', 'warning');
				return;
			}
			customMappings[source] = target;

			// 保存 Tokens：有值则保存，空值则删除
			const tokensVal = document.getElementById('map-tokens').value.trim();
			if (tokensVal) {
				const tokensNum = parseInt(tokensVal, 10);
				if (isNaN(tokensNum) || tokensNum <= 0) {
					showToast('Tokens 上限必须为正整数', 'warning');
					return;
				}
				modelTokensConfig[target] = tokensNum;
			} else {
				delete modelTokensConfig[target];
			}

			const res = await apiFetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: customMappings, modelTokens: modelTokensConfig })
			});
			if (res.ok) {
				document.getElementById('map-source').value = '';
				document.getElementById('map-target').value = '';
				document.getElementById('map-tokens').value = '';
				loadSettings();
				showToast('映射配置成功！');
			} else {
				showToast('添加映射失败！', 'error');
			}
		}

		async function restorePresetMappings() {
			const mergedMappings = { ...customMappings, ...defaultMappings };
			const hasChanges = Object.keys(defaultMappings).some(source => customMappings[source] !== defaultMappings[source]);

			if (!hasChanges) {
				showToast('预设映射已存在，无需重复添加');
				return;
			}

			const res = await apiFetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: mergedMappings })
			});
			if (res.ok) {
				customMappings = mergedMappings;
				loadSettings();
				showToast('已恢复预设映射');
			} else {
				showToast('恢复预设映射失败！', 'error');
			}
		}

		async function deleteMapping(source) {
			if (!confirm('确定要删除此映射吗？')) return;
			const target = customMappings[source];
			delete customMappings[source];
			// 同时清理该目标模型的 Tokens 配置
			if (target && modelTokensConfig[target] !== undefined) {
				delete modelTokensConfig[target];
			}
			const res = await apiFetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: customMappings, modelTokens: modelTokensConfig })
			});
			if (res.ok) {
				loadSettings();
				showToast('已删除映射');
			} else {
				showToast('删除映射失败！', 'error');
			}
		}

		let allFreeModels = [];

		async function fetchFreeModels() {
			document.getElementById('model-select-modal').classList.add('active');
			document.getElementById('model-search-input').value = '';
			const listEl = document.getElementById('model-select-list');
			listEl.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);">正在查询 @cf/ 免费模型...</div>';
			try {
				const res = await apiFetch('/api/models/search');
				const data = await res.json();
				if (!res.ok) {
					listEl.innerHTML = \`<div style="text-align: center; padding: 30px; color: var(--danger-color);">\${escapeHtml(data.error || '获取失败')}</div>\`;
					return;
				}
				allFreeModels = (data.models || []).map(m => {
					const shortName = (m.name || m.id).split('/').pop();
					return { fullName: m.name || m.id, shortName };
				});
				if (allFreeModels.length === 0) {
					listEl.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);">未找到 @cf/ 模型，请检查账号配置</div>';
					return;
				}
				renderModelList(allFreeModels);
			} catch (e) {
				listEl.innerHTML = \`<div style="text-align: center; padding: 30px; color: var(--danger-color);">获取失败: \${escapeHtml(e.message)}</div>\`;
			}
		}

		function filterModelList() {
			const query = (document.getElementById('model-search-input').value || '').toLowerCase();
			const filtered = query
				? allFreeModels.filter(m => m.shortName.toLowerCase().includes(query) || m.fullName.toLowerCase().includes(query))
				: allFreeModels;
			renderModelList(filtered);
		}

		function renderModelList(models) {
			const listEl = document.getElementById('model-select-list');
			if (models.length === 0) {
				listEl.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);">无匹配结果</div>';
				return;
			}
			listEl.innerHTML = models.map(m => \`
				<div style="padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--border-color); font-size: 13px; line-height: 1.5;"
					 onclick="addMappingFromModel(\${attrEscape(m.shortName)}, \${attrEscape(m.fullName)})">
					<strong>\${escapeHtml(m.shortName)}</strong>
					<span style="display: block; font-size: 11px; color: var(--text-muted); margin-top: 2px;">→ \${escapeHtml(m.fullName)}</span>
				</div>
			\`).join('');
		}

		async function addMappingFromModel(source, target) {
			document.getElementById('map-source').value = source;
			document.getElementById('map-target').value = target;
			await addMapping();
			document.getElementById('model-select-modal').classList.remove('active');
		}

		async function loadLimits() {
			try {
				const res = await apiFetch('/api/limits');
				const data = await res.json();
				document.getElementById('limits-daily').value = data.dailyLimit;
				document.getElementById('limits-monthly').value = data.monthlyLimit;
				document.getElementById('limits-threshold').value = data.threshold;
			} catch (e) {
				console.error(e);
				showToast('加载限额配置失败', 'error');
			}
		}

		async function saveLimits() {
			const daily = parseInt(document.getElementById('limits-daily').value, 10);
			const monthly = parseInt(document.getElementById('limits-monthly').value, 10);
			const threshold = parseFloat(document.getElementById('limits-threshold').value);

			if (isNaN(daily) || daily < 0) {
				showToast('每日限额必须是非负整数', 'error');
				return;
			}
			if (isNaN(monthly) || monthly < 0) {
				showToast('每月限额必须是非负整数', 'error');
				return;
			}
			if (isNaN(threshold) || threshold < 0 || threshold > 1) {
				showToast('阈值必须在 0-1 之间', 'error');
				return;
			}

			const res = await apiFetch('/api/limits', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dailyLimit: daily, monthlyLimit: monthly, threshold })
			});

			const msgEl = document.getElementById('limits-save-msg');
			if (res.ok) {
				msgEl.style.display = 'inline';
				msgEl.style.color = 'var(--success-color)';
				msgEl.textContent = '保存成功';
				showToast('限额配置已保存');
			} else {
				msgEl.style.display = 'inline';
				msgEl.style.color = 'var(--danger-color)';
				msgEl.textContent = '保存失败';
				showToast('保存失败', 'error');
			}
			setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
		}
	</script>
</body>
</html>`;

	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Set-Cookie': csrfCookie,
			'X-Content-Type-Options': 'nosniff',
			'X-Frame-Options': 'DENY'
		}
	});
}
