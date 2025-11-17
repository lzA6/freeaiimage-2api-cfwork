// =================================================================================
//  项目: freeai-2-api (Cloudflare Worker 单文件版)
//  版本: 2.2.0 (代号: Phoenix Cockpit)
//  作者: 首席开发者体验架构师
//  协议: MIT
//  日期: 2024-05-23
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker。它将 freeaiimage.net
//  的后端服务，无损地转换为一个高性能、兼容 OpenAI 标准的图片生成 API，并内置了
//  一个功能强大的"开发者驾驶舱"Web UI，用于实时监控、测试和集成。
//
//  v2.2.0 升级 (基于上游故障分析):
//  1. [增强-错误处理] 新增对上游 500 (内含 402) 错误的特殊识别和翻译，提供更友好的用户提示。
//  2. [UI/UX] 驾驶舱状态指示器和交互终端现在能更智能地反馈上游服务故障。
//  3. [优化] 新增对 /favicon.ico 的处理，返回 204 No Content，消除浏览器控制台的 404 错误。
//  4. [健壮性] 进一步强化了所有 fetch 调用和 JSON 解析的 try-catch 块，确保 Worker 自身绝不崩溃。
// =================================================================================

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  PROJECT_NAME: "freeai-2-api",
  PROJECT_VERSION: "2.2.0",
  API_MASTER_KEY: "freeai-to-api-key", // 强烈建议在 Cloudflare 环境变量中覆盖此值
  UPSTREAM_URL: "https://freeaiimage.net",
  DEFAULT_MODEL: "dall-e-3",
  COMPATIBLE_MODELS: ["dall-e-3", "freeai-image", "gpt-image"],
  POLL_INTERVAL_MS: 2000,
  POLL_TIMEOUT_MS: 180000,
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    if (env.API_MASTER_KEY) {
      CONFIG.API_MASTER_KEY = env.API_MASTER_KEY;
    }
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === '/') {
      return handleUI(request);
    } else if (pathname === '/favicon.ico') {
      return new Response(null, { status: 204 }); // 消除 favicon.ico 404 错误
    } else if (pathname.startsWith('/v1/') || pathname === '/generate' || pathname === '/health') {
      return handleApi(request);
    } else {
      return createJsonResponse({
        error: { message: `路径未找到: ${pathname}`, type: 'invalid_request_error', code: 'not_found' }
      }, 404);
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

async function handleApi(request) {
  if (request.method === 'OPTIONS') {
    return handleCorsPreflight();
  }

  if (new URL(request.url).pathname === '/health') {
    // 扩展健康检查，尝试连接上游
    try {
        const upstreamRes = await fetch(CONFIG.UPSTREAM_URL, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
        return createJsonResponse({ 
            status: "healthy", 
            service: CONFIG.PROJECT_NAME, 
            version: CONFIG.PROJECT_VERSION,
            upstream_status: upstreamRes.ok ? 'online' : `offline (${upstreamRes.status})`
        });
    } catch (e) {
        return createJsonResponse({ 
            status: "healthy", 
            service: CONFIG.PROJECT_NAME, 
            version: CONFIG.PROJECT_VERSION,
            upstream_status: 'unreachable'
        });
    }
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.substring(7) !== CONFIG.API_MASTER_KEY) {
    return createJsonResponse({ error: { message: '无效或缺失的 API Key。', type: 'invalid_api_key' } }, 401);
  }

  const requestId = `img-${crypto.randomUUID()}`;

  if (new URL(request.url).pathname === '/v1/images/generations' || new URL(request.url).pathname === '/generate') {
    return handleImageGeneration(request, requestId);
  } else {
    return createJsonResponse({ error: { message: `API 路径不支持: ${new URL(request.url).pathname}`, type: 'not_found' } }, 404);
  }
}

async function handleImageGeneration(request, requestId) {
  if (request.method !== 'POST') {
    return createJsonResponse({ error: { message: '此端点仅支持 POST 方法。' } }, 405);
  }

  try {
    const body = await request.json();
    const { prompt, n = 1, size = "1024x1024" } = body;

    if (!prompt) {
      return createJsonResponse({ error: { message: '缺少必须的 `prompt` 参数。' } }, 400);
    }

    const aspectRatio = sizeToAspectRatio(size);
    if (!aspectRatio) {
        return createJsonResponse({ error: { message: `不支持的 'size' 参数: ${size}。请使用 1:1, 4:3, 3:4 等常见比例的尺寸。` } }, 400);
    }

    const upstreamPayload = {
      prompt: prompt.trim(),
      aspectRatio: aspectRatio,
    };

    // 1. 创建任务
    const taskResponse = await fetch(`${CONFIG.UPSTREAM_URL}/api/services/create-qwen-image`, {
      method: 'POST',
      headers: createUpstreamHeaders(requestId),
      body: JSON.stringify(upstreamPayload),
    });

    // 增强的错误处理
    if (!taskResponse.ok) {
        let errorText = await taskResponse.text();
        if (taskResponse.status === 429) {
            throw new Error(`请求过于频繁，请稍候。上游提示: ${errorText}`);
        }
        if (taskResponse.status === 403) {
            try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.code === 'SENSITIVE_CONTENT') {
                    throw new Error(`提示词包含不适当内容，已被上游拒绝。详情: ${errorJson.error}`);
                }
            } catch (e) { /* 忽略JSON解析失败 */ }
        }
        if (taskResponse.status === 500) {
             if (errorText.includes("402")) {
                throw new Error(`上游服务内部错误 (可能原因：配额耗尽或服务暂时不可用)。上游状态: ${taskResponse.status}`);
             }
        }
        throw new Error(`创建任务失败 (上游状态: ${taskResponse.status}): ${errorText}`);
    }

    const taskData = await taskResponse.json();
    if (!taskData.success || !taskData.task_id) {
      throw new Error(`上游未能成功创建任务: ${JSON.stringify(taskData)}`);
    }

    // 2. 轮询等待结果
    const result = await waitForCompletion(taskData.task_id, requestId);

    // 3. 格式化为 OpenAI 兼容响应
    const openAIResponse = {
      created: Math.floor(Date.now() / 1000),
      data: result.images.map(url => ({
        revised_prompt: result.prompt,
        url: url,
      })),
    };

    return createJsonResponse(openAIResponse, 200, { 'X-Worker-Trace-ID': requestId });

  } catch (e) {
    console.error(`[${requestId}] 图片生成失败:`, e.message);
    // 返回 502 Bad Gateway 表示上游问题
    return createJsonResponse({ error: { message: e.message, type: 'upstream_error' } }, 502);
  }
}

async function waitForCompletion(taskId, requestId) {
  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.POLL_TIMEOUT_MS) {
    const statusUrl = `${CONFIG.UPSTREAM_URL}/api/services/aigc/task?taskId=${taskId}&taskType=qwen_image`;
    const statusResponse = await fetch(statusUrl, {
      method: 'GET',
      headers: createUpstreamHeaders(requestId),
    });

    if (statusResponse.ok) {
        const statusData = await statusResponse.json();
        if (statusData.status === 'completed' && statusData.data) {
          return { prompt: statusData.params.prompt, images: statusData.data };
        }
        if (statusData.status === 'failed') {
          throw new Error('上游任务执行失败。');
        }
    }
    
    await new Promise(resolve => setTimeout(resolve, CONFIG.POLL_INTERVAL_MS));
  }
  throw new Error('任务轮询超时。');
}

// --- [第四部分: 辅助函数] ---

function createJsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extraHeaders,
    },
  });
}

function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function createUpstreamHeaders(requestId) {
  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json, text/plain, */*');
  headers.set('Origin', CONFIG.UPSTREAM_URL);
  headers.set('Referer', `${CONFIG.UPSTREAM_URL}/zh/`);
  headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
  headers.set('Cookie', 'lng=InpoIg%3D%3D');
  headers.set('X-Request-ID', requestId);
  return headers;
}

function sizeToAspectRatio(size) {
    const parts = size.split('x').map(Number);
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
    const [width, height] = parts;
    const ratio = width / height;
    const ratios = { "1:1": 1, "4:3": 4/3, "3:4": 3/4, "16:9": 16/9, "9:16": 9/16 };
    let closest = "1:1";
    let minDiff = Math.abs(ratio - 1);
    for (const [key, value] of Object.entries(ratios)) {
        const diff = Math.abs(ratio - value);
        if (diff < minDiff) { minDiff = diff; closest = key; }
    }
    return closest;
}

// --- [第五部分: 开发者驾驶舱 UI] ---
// (UI部分与v2.1基本相同，仅在JS逻辑中增强了错误显示，此处为节省篇幅，仅展示JS部分的修改)
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { --bg-color: #121212; --sidebar-bg: #1E1E1E; --border-color: #333333; --text-color: #E0E0E0; --text-secondary: #888888; --primary-color: #FFBF00; --primary-hover: #FFD700; --input-bg: #2A2A2A; --error-color: #CF6679; --success-color: #66BB6A; --font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; --font-mono: 'Fira Code', 'Consolas', 'Monaco', monospace; }
      * { box-sizing: border-box; }
      body { font-family: var(--font-family); margin: 0; background-color: var(--bg-color); color: var(--text-color); font-size: 14px; display: flex; height: 100vh; overflow: hidden; }
      .skeleton { background-color: #2a2a2a; background-image: linear-gradient(90deg, #2a2a2a, #3a3a3a, #2a2a2a); background-size: 200% 100%; animation: skeleton-loading 1.5s infinite; border-radius: 4px; }
      @keyframes skeleton-loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    </style>
</head>
<body>
    <main-layout></main-layout>
    <template id="main-layout-template">
      <style>
        .layout { display: flex; width: 100%; height: 100vh; }
        .sidebar { width: 380px; flex-shrink: 0; background-color: var(--sidebar-bg); border-right: 1px solid var(--border-color); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
        .main-content { flex-grow: 1; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); }
        h1 { margin: 0; font-size: 20px; } .version { font-size: 12px; color: var(--text-secondary); margin-left: 8px; }
        .collapsible-section { margin-top: 20px; }
        .collapsible-section summary { cursor: pointer; font-weight: bold; margin-bottom: 10px; list-style-position: inside; }
        .collapsible-section summary::marker { color: var(--primary-color); }
        .api-reference table { width: 100%; border-collapse: collapse; font-size: 12px; } .api-reference th, .api-reference td { border: 1px solid var(--border-color); padding: 6px 8px; text-align: left; } .api-reference th { background-color: var(--input-bg); } .api-reference td:first-child { font-family: var(--font-mono); color: var(--primary-color); }
        .notice { font-size: 12px; color: var(--text-secondary); background-color: var(--input-bg); padding: 10px; border-radius: 4px; border-left: 3px solid var(--primary-color); }
        @media (max-width: 900px) { .layout { flex-direction: column; } .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border-color); } }
      </style>
      <div class="layout">
        <aside class="sidebar">
          <header class="header"><h1>${CONFIG.PROJECT_NAME}<span class="version">v${CONFIG.PROJECT_VERSION}</span></h1><status-indicator></status-indicator></header>
          <info-panel></info-panel>
          <details class="collapsible-section" open><summary>⚠️ 使用限制与须知</summary><div class="notice"><p><strong>内容审查:</strong> 上游服务会对提示词进行严格的 NSFW 审查。如果包含敏感内容，请求将被拒绝。</p><p><strong>速率限制:</strong> 为防止滥用，上游服务存在请求频率限制。如遇 429 错误，请等待几秒后再试。</p><p><strong>上游稳定性:</strong> 本服务依赖于第三方，其稳定性不受我们控制。如遇 5xx 错误，通常是上游问题，可能原因包括配额耗尽或服务暂时不可用。</p></div></details>
          <details class="collapsible-section" open><summary>⚙️ 主流客户端集成指南</summary><client-guides></client-guides></details>
          <details class="collapsible-section"><summary>🔌 兼容接口参考</summary><div class="api-reference"><table><thead><tr><th>方法</th><th>路径</th><th>描述</th></tr></thead><tbody><tr><td>POST</td><td>/v1/images/generations</td><td>生成图片</td></tr><tr><td>POST</td><td>/generate</td><td>生成图片 (简化路径)</td></tr><tr><td>GET</td><td>/health</td><td>健康检查</td></tr></tbody></table></div></details>
        </aside>
        <main class="main-content"><live-terminal></live-terminal></main>
      </div>
    </template>
    <template id="status-indicator-template"><style>.indicator{display:flex;align-items:center;gap:8px;font-size:12px}.dot{width:10px;height:10px;border-radius:50%;transition:background-color .3s}.dot.grey{background-color:#555}.dot.yellow{background-color:var(--primary-color);animation:pulse 2s infinite}.dot.green{background-color:var(--success-color)}.dot.red{background-color:var(--error-color)}@keyframes pulse{0%{box-shadow:0 0 0 0 #ffbf0066}70%{box-shadow:0 0 0 10px #ffbf0000}100%{box-shadow:0 0 0 0 #ffbf0000}}</style><div class="indicator"><div id="status-dot" class="dot grey"></div><span id="status-text">正在初始化...</span></div></template>
    <template id="info-panel-template"><style>.panel{display:flex;flex-direction:column;gap:12px}.info-item{display:flex;flex-direction:column}.info-item label{font-size:12px;color:var(--text-secondary);margin-bottom:4px}.info-value{background-color:var(--input-bg);padding:8px 12px;border-radius:4px;font-family:var(--font-mono);font-size:13px;color:var(--primary-color);display:flex;align-items:center;justify-content:space-between;word-break:break-all}.info-value.password{-webkit-text-security:disc}.info-value.visible{-webkit-text-security:none}.actions{display:flex;gap:8px}.icon-btn{background:0 0;border:none;color:var(--text-secondary);cursor:pointer;padding:2px;display:flex;align-items:center}.icon-btn:hover{color:var(--text-color)}.icon-btn svg{width:16px;height:16px}.skeleton{height:34px}</style><div class="panel"><div class="info-item"><label>API 端点 (Base URL)</label><div id="api-url" class="info-value skeleton"></div></div><div class="info-item"><label>API 密钥 (Master Key)</label><div id="api-key" class="info-value password skeleton"></div></div><div class="info-item"><label>默认模型 (Default Model)</label><div id="default-model" class="info-value skeleton"></div></div></div></template>
    <template id="client-guides-template"><style>.tabs{display:flex;border-bottom:1px solid var(--border-color)}.tab{padding:8px 12px;cursor:pointer;border:none;background:0 0;color:var(--text-secondary);font-size:13px}.tab.active{color:var(--primary-color);border-bottom:2px solid var(--primary-color);font-weight:700}.content{padding:15px 0}pre{background-color:var(--input-bg);padding:12px;border-radius:4px;font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-all;position:relative}.copy-code-btn{position:absolute;top:8px;right:8px;background:#444;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;padding:3px 6px;font-size:10px}.copy-code-btn:hover{background:#555}.copy-code-btn.copied{background-color:var(--success-color);color:var(--bg-color)}</style><div><div class="tabs"></div><div class="content"></div></div></template>
    <template id="live-terminal-template"><style>.terminal{display:flex;flex-direction:column;height:100%;background-color:var(--sidebar-bg);border:1px solid var(--border-color);border-radius:8px;overflow:hidden}.output-window{flex-grow:1;padding:15px;overflow-y:auto;font-size:14px;line-height:1.6}.message{margin-bottom:1.2em;padding:10px;border-radius:6px}.message.user{background-color:rgba(255,191,0,.1);border-left:3px solid var(--primary-color)}.message.assistant .image-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:10px}.message.assistant img{max-width:100%;border-radius:4px;cursor:pointer;transition:transform .2s}.message.assistant img:hover{transform:scale(1.05)}.message.system,.message.error{background-color:rgba(207,102,121,.1);border-left:3px solid var(--error-color)}.message-label{font-weight:700;font-size:12px;color:var(--text-secondary);margin-bottom:5px}.input-area{border-top:1px solid var(--border-color);padding:15px;display:flex;gap:10px;align-items:flex-end}.input-controls{display:flex;flex-direction:column;gap:5px;flex-grow:1}textarea{width:100%;background-color:var(--input-bg);border:1px solid var(--border-color);border-radius:4px;color:var(--text-color);padding:10px;font-family:var(--font-family);font-size:14px;resize:none;min-height:40px;max-height:200px}select{background-color:var(--input-bg);border:1px solid var(--border-color);color:var(--text-color);padding:5px;border-radius:4px;font-size:12px}.send-btn{background-color:var(--primary-color);color:#121212;border:none;border-radius:4px;padding:0 15px;height:40px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}.send-btn:hover{background-color:var(--primary-hover)}.send-btn:disabled{background-color:#555;cursor:not-allowed}.send-btn.cancel{background-color:var(--error-color);color:#fff}.send-btn svg{width:20px;height:20px}.placeholder{color:var(--text-secondary);text-align:center;padding:20px}</style><div class="terminal"><div class="output-window"><p class="placeholder">🚀 实时交互终端已就绪。<br>输入图片描述，点击发送，开始生成您的第一张 AI 图片！</p></div><div class="input-area"><div class="input-controls"><textarea id="prompt-input" rows="1" placeholder="例如：一只戴着宇航员头盔的猫，在月球上喝牛奶"></textarea><select id="size-select"><option value="1024x1024">尺寸: 1024x1024 (1:1)</option><option value="1024x768">尺寸: 1024x768 (4:3)</option><option value="768x1024">尺寸: 768x1024 (3:4)</option></select></div><button id="send-btn" class="send-btn" title="发送"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.949a.75.75 0 00.95.544l3.239-1.281a.75.75 0 000-1.39L4.23 6.28a.75.75 0 00-.95-.545L1.865 3.45a.75.75 0 00.95-.826l.002-.007.002-.006zm.002 14.422a.75.75 0 00.95.826l1.415-2.28a.75.75 0 00-.545-.95l-3.239-1.28a.75.75 0 00-1.39 0l-1.28 3.239a.75.75 0 00.544.95l4.95 1.414zM12.75 8.5a.75.75 0 000 1.5h5.5a.75.75 0 000-1.5h-5.5z"/></svg></button></div></div></template>
    <script>
      const CLIENT_CONFIG = { WORKER_ORIGIN: '${origin}', API_MASTER_KEY: '${CONFIG.API_MASTER_KEY}', DEFAULT_MODEL: '${CONFIG.DEFAULT_MODEL}', COMPATIBLE_MODELS_STRING: '${CONFIG.COMPATIBLE_MODELS.join(', ')}' };
      const AppState = { INITIALIZING: 'INITIALIZING', HEALTH_CHECKING: 'HEALTH_CHECKING', READY: 'READY', REQUESTING: 'REQUESTING', ERROR: 'ERROR' };
      let currentState = AppState.INITIALIZING, abortController = null;
      class BaseComponent extends HTMLElement { constructor(id) { super(); this.attachShadow({mode:'open'}); const t = document.getElementById(id); if(t) this.shadowRoot.appendChild(t.content.cloneNode(!0)); } }
      class MainLayout extends BaseComponent { constructor() { super('main-layout-template'); } }
      customElements.define('main-layout', MainLayout);
      class StatusIndicator extends BaseComponent { constructor() { super('status-indicator-template'); this.dot = this.shadowRoot.getElementById('status-dot'); this.text = this.shadowRoot.getElementById('status-text'); } setState(state, msg) { this.dot.className = 'dot'; switch(state) { case 'checking': this.dot.classList.add('yellow'); break; case 'ok': this.dot.classList.add('green'); break; case 'error': this.dot.classList.add('red'); break; default: this.dot.classList.add('grey'); } this.text.textContent = msg; } }
      customElements.define('status-indicator', StatusIndicator);
      class InfoPanel extends BaseComponent { constructor() { super('info-panel-template'); this.apiUrlEl = this.shadowRoot.getElementById('api-url'); this.apiKeyEl = this.shadowRoot.getElementById('api-key'); this.defaultModelEl = this.shadowRoot.getElementById('default-model'); } connectedCallback() { this.render(); } render() { this.populateField(this.apiUrlEl, CLIENT_CONFIG.WORKER_ORIGIN); this.populateField(this.apiKeyEl, CLIENT_CONFIG.API_MASTER_KEY, !0); this.populateField(this.defaultModelEl, CLIENT_CONFIG.DEFAULT_MODEL); } populateField(el, val, isPwd = !1) { el.classList.remove('skeleton'); el.innerHTML = \`<span>\${val}</span><div class="actions">\${isPwd ? '<button class="icon-btn" data-action="toggle-visibility" title="切换可见性"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5Z"/><path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473ZM18.45 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473ZM10 17a1.651 1.651 0 01-1.18 0l-1.473-.88a1.65 1.65 0 010-2.899l1.473-.88a1.651 1.651 0 011.18 0l1.473.88a1.65 1.65 0 010 2.899l-1.473.88a1.651 1.651 0 01-1.18 0Z" clip-rule="evenodd"/></svg></button>' : ''}<button class="icon-btn" data-action="copy" title="复制"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0117 6.621V16.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 017 16.5v-13Z"/><path d="M5 6.5A1.5 1.5 0 016.5 5h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0115 9.621V14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 015 14.5v-8Z"/></svg></button></div>\`; el.querySelector('[data-action="copy"]').addEventListener('click', e => this.copyValue(e.currentTarget, val)); if (isPwd) el.querySelector('[data-action="toggle-visibility"]').addEventListener('click', () => el.classList.toggle('visible')); } copyValue(btn, val) { navigator.clipboard.writeText(val); btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1500); } }
      customElements.define('info-panel', InfoPanel);
      class ClientGuides extends BaseComponent { constructor() { super('client-guides-template'); this.tabs = this.shadowRoot.querySelector('.tabs'); this.content = this.shadowRoot.querySelector('.content'); } connectedCallback() { const guides = { 'cURL': this.getGuide('cURL'), 'Python': this.getGuide('Python'), 'LobeChat': this.getGuide('LobeChat'), 'Next-Web': this.getGuide('Next-Web') }; Object.keys(guides).forEach((name, i) => { const tab = document.createElement('button'); tab.className = 'tab'; tab.textContent = name; if (i === 0) tab.classList.add('active'); tab.addEventListener('click', () => this.switchTab(name, guides)); this.tabs.appendChild(tab); }); this.switchTab(Object.keys(guides)[0], guides); } switchTab(name, guides) { this.tabs.querySelector('.active')?.classList.remove('active'); this.tabs.children[Object.keys(guides).indexOf(name)].classList.add('active'); this.content.innerHTML = guides[name]; this.content.querySelector('.copy-code-btn')?.addEventListener('click', e => { const code = e.target.closest('pre').querySelector('code').innerText; navigator.clipboard.writeText(code); e.target.textContent = '已复制!'; setTimeout(() => e.target.textContent = '复制', 1500); }); } getGuide(type) { const { WORKER_ORIGIN: baseUrl, API_MASTER_KEY: apiKey, DEFAULT_MODEL: defaultModel, COMPATIBLE_MODELS_STRING: models } = CLIENT_CONFIG; let content = ''; switch(type) { case 'cURL': content = \`curl \${baseUrl}/v1/images/generations \\\\\n  -H "Authorization: Bearer \${apiKey}" \\\\\n  -H "Content-Type: application/json" \\\\\n  -d '{\n    "model": "\${defaultModel}",\n    "prompt": "A cute cat",\n    "n": 1,\n    "size": "1024x1024"\n  }'\`; break; case 'Python': content = \`from openai import OpenAI\n\nclient = OpenAI(\n    api_key="\${apiKey}",\n    base_url="\${baseUrl}/v1"\n)\n\nresponse = client.images.generate(\n    model="\${defaultModel}",\n    prompt="A cute cat",\n    n=1,\n    size="1024x1024"\n)\n\nprint(response.data[0].url)\`; break; case 'LobeChat': content = \`在 LobeChat 设置中，找到 "语言模型" -> "OpenAI" 设置:\n- API Key: \${apiKey}\n- API 地址: \${baseUrl}\n- 模型列表: \${models}\`; break; case 'Next-Web': content = \`在 ChatGPT-Next-Web 部署时，设置以下环境变量:\n- CODE: \${apiKey}\n- BASE_URL: \${baseUrl}\n- CUSTOM_MODELS: \${models}\`; break; } return \`<pre><button class="copy-code-btn">复制</button><code>\${content}</code></pre>\`; } }
      customElements.define('client-guides', ClientGuides);
      class LiveTerminal extends BaseComponent { constructor() { super('live-terminal-template'); this.output = this.shadowRoot.querySelector('.output-window'); this.input = this.shadowRoot.getElementById('prompt-input'); this.sizeSelect = this.shadowRoot.getElementById('size-select'); this.sendBtn = this.shadowRoot.getElementById('send-btn'); this.sendIcon = this.sendBtn.innerHTML; this.cancelIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16Z M8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22Z"/></svg>'; } connectedCallback() { this.sendBtn.addEventListener('click', () => this.handleSend()); this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } }); this.input.addEventListener('input', this.autoResize); } autoResize(e) { const t = e.target; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; } handleSend() { if (currentState === AppState.REQUESTING) this.cancelRequest(); else this.startRequest(); } addMessage(role, content, images = []) { const msgEl = document.createElement('div'); msgEl.className = 'message ' + role; const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role.toUpperCase(); msgEl.appendChild(label); if (content) { const contentEl = document.createElement('div'); contentEl.textContent = content; msgEl.appendChild(contentEl); } if (images.length > 0) { const gallery = document.createElement('div'); gallery.className = 'image-gallery'; images.forEach(url => { const img = document.createElement('img'); img.src = url; img.alt = content; img.onclick = () => window.open(url, '_blank'); gallery.appendChild(img); }); msgEl.appendChild(gallery); } this.output.querySelector('.placeholder')?.remove(); this.output.appendChild(msgEl); this.output.scrollTop = this.output.scrollHeight; return msgEl; } async startRequest() { const prompt = this.input.value.trim(); if (!prompt) return; setState(AppState.REQUESTING); this.addMessage('user', prompt); const assistantMsg = this.addMessage('assistant', '⏳ 正在请求上游服务，请稍候...'); abortController = new AbortController(); try { const res = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/v1/images/generations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY }, body: JSON.stringify({ model: CLIENT_CONFIG.DEFAULT_MODEL, prompt: prompt, n: 1, size: this.sizeSelect.value }), signal: abortController.signal }); const data = await res.json(); if (!res.ok) throw new Error(data.error?.message || '未知错误'); assistantMsg.remove(); this.addMessage('assistant', \`生成成功！提示词: \${data.data[0].revised_prompt}\`, data.data.map(d => d.url)); this.input.value = ''; this.autoResize({target: this.input}); } catch (e) { if (e.name !== 'AbortError') { assistantMsg.remove(); this.addMessage('error', '请求失败: ' + e.message); setState(AppState.ERROR); } } finally { if (currentState !== AppState.ERROR) setState(AppState.READY); } } cancelRequest() { if (abortController) { abortController.abort(); abortController = null; } this.addMessage('system', '请求已取消。'); setState(AppState.READY); } updateButtonState(state) { if (state === AppState.REQUESTING) { this.sendBtn.innerHTML = this.cancelIcon; this.sendBtn.title = "取消"; this.sendBtn.classList.add('cancel'); this.sendBtn.disabled = !1; } else { this.sendBtn.innerHTML = this.sendIcon; this.sendBtn.title = "发送"; this.sendBtn.classList.remove('cancel'); this.sendBtn.disabled = state !== AppState.READY; } } }
      customElements.define('live-terminal', LiveTerminal);
      function setState(newState) { currentState = newState; const term = document.querySelector('main-layout')?.shadowRoot.querySelector('live-terminal'); if (term) term.updateButtonState(newState); const indicator = document.querySelector('main-layout')?.shadowRoot.querySelector('status-indicator'); if(indicator && newState === AppState.ERROR) indicator.setState('error', '上游服务故障'); }
      async function performHealthCheck() { const indicator = document.querySelector('main-layout')?.shadowRoot.querySelector('status-indicator'); if (!indicator) return; indicator.setState('checking', '检查服务...'); try { const res = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/health', { headers: { 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY } }); const data = await res.json(); if (res.ok && data.upstream_status === 'online') { indicator.setState('ok', '服务运行正常'); setState(AppState.READY); } else { throw new Error(\`上游状态: \${data.upstream_status}\`); } } catch (e) { indicator.setState('error', '服务检查失败'); setState(AppState.ERROR); } }
      document.addEventListener('DOMContentLoaded', () => { setState(AppState.INITIALIZING); customElements.whenDefined('main-layout').then(() => { performHealthCheck(); }); });
    </script>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
