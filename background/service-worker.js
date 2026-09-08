// Service Worker：消息路由、LLM API 调用（多供应商）、缓存
import {
  detectRole,
  buildSystemPrompt,
  buildUserPrompt,
  parseTranslationResponse,
  langName,
  ROLES,
  buildCacheKey,
} from '../lib/prompts.js';
import { normalizeSettings, resolveActiveProvider } from '../lib/provider.js';

const DEFAULT_SETTINGS = {
  provider: 'opencode',
  providers: {
    opencode: { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' },
    lmstudio: { baseUrl: 'http://localhost:1234/v1', apiKey: '' },
    custom: { baseUrl: '', apiKey: '' },
  },
  models: { opencode: 'deepseek-v4-flash', lmstudio: '', custom: '' },
  targetLang: 'zh-CN',
  mode: 'bilingual', // bilingual | mono
  roleOverride: 'auto',
  extraInstruction: '',
  batchSize: 12,
  concurrency: 2,
  urlBlacklist: [],
  reasoning: 'off', // off | low | high（仅 OpenCode Go 供应商生效，本地模型不发思考参数）
};

const CACHE_MAX = 800;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天（借鉴 ReadFrog 缓存策略）
const CACHE_PREFIX = 'pt-cache2:'; // v2：SHA-256 + 附加指令参与 key（v1 为 pt-cache:，onInstalled 时清理）

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  const s = normalizeSettings(stored);
  return { ...DEFAULT_SETTINGS, ...s };
}

// ---------- 缓存（storage.local 持久化 + 7 天 TTL + LRU 上限） ----------

async function cacheGet(keys) {
  if (!keys.length) return {};
  const res = await chrome.storage.local.get(keys);
  const now = Date.now();
  const valid = {};
  const expired = [];
  for (const [k, v] of Object.entries(res)) {
    if (v && typeof v === 'object' && typeof v.t === 'string' && now - (v.at || 0) < CACHE_TTL_MS) {
      valid[k] = v.t;
    } else {
      expired.push(k);
    }
  }
  if (expired.length) await chrome.storage.local.remove(expired);
  return valid;
}

let cacheWriteCount = 0;

async function cacheSet(entries) {
  const keys = Object.keys(entries);
  if (!keys.length) return;
  const now = Date.now();
  const wrapped = {};
  for (const k of keys) wrapped[k] = { t: entries[k], at: now };
  // LRU 清理需全量读取，节流：每 12 次写才清理一次，避免高频批次的额外开销
  const needSweep = (++cacheWriteCount % 12 === 1);
  if (needSweep) {
    const all = await chrome.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    const expired = cacheKeys.filter((k) => now - (all[k]?.at || 0) >= CACHE_TTL_MS);
    const alive = cacheKeys.filter((k) => !expired.includes(k));
    const overflow = alive.length + keys.length - CACHE_MAX;
    const toRemove = [...expired, ...alive.slice(0, Math.max(0, overflow))];
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  }
  await chrome.storage.local.set(wrapped);
}

// ---------- LLM API 调用（按供应商解析配置） ----------

function apiHeaders(cfg, sessionId) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  // OpenCode Go 要求第三方工具正确自我标识，并携带会话头用于 prompt caching；
  // 本地/自定义供应商不发这些头
  if (cfg.isOpencode) {
    headers['x-opencode-client'] = 'pure-translate/1.0';
    if (sessionId) headers['x-opencode-session'] = sessionId;
  }
  return headers;
}

// 思考强度参数（用户可选；关闭思考可显著提升翻译输出速度）
function reasoningParams(reasoning) {
  if (reasoning === 'low' || reasoning === 'high') {
    return { thinking: { type: 'enabled' }, reasoning_effort: reasoning };
  }
  // 默认关闭思考：GLM 系列接受 thinking.disabled；其他模型会忽略未知字段
  return { thinking: { type: 'disabled' } };
}

async function callChatCompletions({ settings, cfg, system, user, sessionId, signal }) {
  const active = cfg || resolveActiveProvider(settings);
  const url = `${active.baseUrl}/chat/completions`;
  const baseBody = {
    model: active.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
  };
  // 思考参数仅发给 OpenCode Go：LM Studio 等本地引擎官方参数表不含 thinking/reasoning_effort
  const extra = active.isOpencode ? reasoningParams(settings.reasoning) : {};
  let useExtra = active.isOpencode;

  // 批量超时随字符数伸缩（借鉴 ReadFrog）；本地模型生成慢，超时放宽
  const timeoutMs = active.isLocal
    ? Math.min(60000 + user.length * 30, 240000)
    : Math.min(20000 + user.length * 15, 120000);
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(new Error('请求超时')), timeoutMs);
  const onAbort = () => timeoutCtrl.abort(new Error('请求超时'));
  signal?.addEventListener('abort', onAbort);

  try {
    let lastErr = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: apiHeaders(active, sessionId),
          body: JSON.stringify(useExtra ? { ...baseBody, ...extra } : baseBody),
          signal: timeoutCtrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
          if (attempt < 2) {
            // 指数退避 + 随机抖动，避免多批次同时重试再次触发限流
            await sleep(1500 * Math.pow(2, attempt) + Math.random() * 800);
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) {
          const text = await res.text();
          // 网关/模型不支持思考参数时剥离重试一次（不消耗重试次数）
          if (res.status === 400 && useExtra && /thinking|reasoning|unknown|unsupported/i.test(text)) {
            useExtra = false;
            attempt--;
            continue;
          }
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new Error('模型响应格式异常：缺少 choices[0].message.content');
        }
        return content;
      } catch (err) {
        if (err.name === 'AbortError' || /请求超时|aborted/i.test(String(err.message))) {
          throw new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s），可在设置中调小每批段落数`);
        }
        lastErr = err;
        if (attempt < 2 && /HTTP (429|5\d\d)/.test(String(err.message))) {
          await sleep(1500 * Math.pow(2, attempt) + Math.random() * 800);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'translate-batch':
        sendResponse(await handleTranslateBatch(msg));
        break;
      case 'translate-selection':
        sendResponse(await handleTranslateSelection(msg));
        break;
      case 'fetch-models':
        sendResponse(await handleFetchModels(msg));
        break;
      case 'test-connection':
        sendResponse(await handleTestConnection(msg));
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message type' });
    }
  })();
  return true; // async response
});

async function resolveRole(url, roleOverride) {
  if (roleOverride && roleOverride !== 'auto' && ROLES[roleOverride]) return roleOverride;
  return detectRole(url);
}

async function handleTranslateBatch(msg) {
  const { texts, title, url, sessionId, targetLang, roleOverride, extraInstruction } = msg;
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: true, translations: [] };
  }
  const settings = await getSettings();
  const cfg = resolveActiveProvider(settings);
  if (cfg.needsKey && !cfg.apiKey) {
    return { ok: false, error: 'NO_API_KEY', errorText: `供应商「${cfg.label}」尚未配置 API Key，请点击扩展图标打开设置。` };
  }
  if (!cfg.model) {
    return { ok: false, error: 'NO_MODEL', errorText: `供应商「${cfg.label}」尚未选择模型，请打开设置。` };
  }

  const role = await resolveRole(url, roleOverride);
  const lang = targetLang || settings.targetLang || 'zh-CN';

  // 缓存命中检查（key 含供应商/模型/语言/角色/附加指令/文本，SHA-256 防碰撞）
  const keys = await Promise.all(texts.map((t) => buildCacheKey(CACHE_PREFIX, {
    model: `${cfg.id}:${cfg.model}`,
    lang,
    role,
    extra: extraInstruction ?? settings.extraInstruction,
    text: t,
  })));
  const cached = await cacheGet(keys);
  const translations = texts.map((_, i) => {
    const v = cached[keys[i]];
    return typeof v === 'string' ? v : null;
  });
  const missIdx = translations.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);

  if (missIdx.length > 0) {
    const segTexts = missIdx.map((i) => texts[i]);
    const system = buildSystemPrompt(role, lang, extraInstruction ?? settings.extraInstruction);
    const user = buildUserPrompt(title || '', ROLES[role]?.label || '通用网页', segTexts, lang);
    try {
      const content = await callChatCompletions({ settings, cfg, system, user, sessionId });
      const parsed = parseTranslationResponse(content, segTexts.length);
      const newEntries = {};
      missIdx.forEach((pageIdx, j) => {
        const t = parsed[j];
        if (typeof t === 'string' && t) {
          translations[pageIdx] = t;
          newEntries[keys[pageIdx]] = t;
        }
      });
      await cacheSet(newEntries);
      const failed = translations.some((t) => t === null);
      return { ok: true, translations, ...(failed ? { partial: true } : {}) };
    } catch (err) {
      return { ok: false, error: 'API_ERROR', errorText: String(err.message || err) };
    }
  }
  return { ok: true, translations };
}

async function handleTranslateSelection(msg) {
  const { text, sessionId } = msg;
  const settings = await getSettings();
  const cfg = resolveActiveProvider(settings);
  if (cfg.needsKey && !cfg.apiKey) {
    return { ok: false, error: 'NO_API_KEY', errorText: `供应商「${cfg.label}」尚未配置 API Key。` };
  }
  const lang = settings.targetLang || 'zh-CN';
  const system =
    `你是专业译者。将用户给出的文本翻译成${langName(lang)}，只输出译文。` +
    '保留专有名词、代码、URL 原文；若原文已是目标语言则原样输出。';
  try {
    const content = await callChatCompletions({
      settings,
      cfg,
      system,
      user: text,
      sessionId,
    });
    return { ok: true, translation: content.trim() };
  } catch (err) {
    return { ok: false, error: 'API_ERROR', errorText: String(err.message || err) };
  }
}

async function handleFetchModels(msg) {
  // msg: { provider, baseUrl, apiKey } —— 按设置页当前选中供应商的表单值请求
  const settings = await getSettings();
  const providerId = msg.provider || settings.provider || 'opencode';
  const base = msg.baseUrl || settings.providers?.[providerId]?.baseUrl;
  const apiKey = msg.apiKey ?? settings.providers?.[providerId]?.apiKey ?? '';
  const baseUrl = String(base || '').replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: '缺少 API Base URL' };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const models = (data?.data || [])
      .map((m) => m.id)
      .filter(Boolean)
      .filter((id) => !/embed|rerank/i.test(id)) // 排除嵌入/重排模型（不能用于翻译）
      .sort();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function handleTestConnection(msg) {
  // msg: { provider, baseUrl, apiKey, model } —— 按设置页当前表单值测试
  const settings = await getSettings();
  const providerId = msg.provider || settings.provider || 'opencode';
  const test = normalizeSettings({
    ...settings,
    provider: providerId,
    providers: {
      ...settings.providers,
      [providerId]: {
        baseUrl: msg.baseUrl || settings.providers?.[providerId]?.baseUrl || '',
        apiKey: msg.apiKey ?? settings.providers?.[providerId]?.apiKey ?? '',
      },
    },
    models: { ...(settings.models || {}), [providerId]: msg.model || settings.models?.[providerId] || '' },
  });
  const cfg = resolveActiveProvider(test);
  if (cfg.needsKey && !cfg.apiKey) return { ok: false, error: `供应商「${cfg.label}」需要 API Key` };
  if (!cfg.model) return { ok: false, error: `供应商「${cfg.label}」未选择模型` };
  try {
    const content = await callChatCompletions({
      settings,
      cfg,
      system: 'You are a translator. Output only the translation.',
      user: 'Hello, world.',
      sessionId: crypto.randomUUID(),
    });
    return { ok: true, sample: content.slice(0, 120) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// ---------- 设置迁移 ----------

// 旧版扁平结构（apiKey/baseUrl/model）→ providers/models；幂等，SW 唤醒时执行
async function migrateSettings() {
  const stored = await chrome.storage.local.get(null);
  if (stored.providers && stored.models && stored.provider) return;
  const s = normalizeSettings(stored);
  await chrome.storage.local.set({
    provider: s.provider,
    providers: s.providers,
    models: s.models,
  });
}
migrateSettings();

// ---------- 右键菜单与快捷键 ----------

chrome.runtime.onInstalled.addListener(() => {
  migrateSettings();
  // 清理 v1 缓存（djb2 旧 key 格式，与新 key 永不匹配）
  chrome.storage.local.get(null).then((all) => {
    const stale = Object.keys(all).filter((k) => k.startsWith('pt-cache:'));
    if (stale.length) chrome.storage.local.remove(stale);
  });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pt-translate-page',
      title: '翻译整个页面',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'pt-translate-selection',
      title: '翻译选中文字',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'pt-restore-page',
      title: '还原页面（撤销翻译）',
      contexts: ['page'],
    });
  });
});

async function sendToActiveTab(action, extra = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: action, ...extra });
  } catch {
    // content script 未注入（如 chrome:// 页面），忽略
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'pt-translate-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'toggle-translate' }).catch(() => {});
  } else if (info.menuItemId === 'pt-restore-page') {
    chrome.tabs.sendMessage(tab.id, { type: 'restore-page' }).catch(() => {});
  } else if (info.menuItemId === 'pt-translate-selection') {
    chrome.tabs.sendMessage(tab.id, { type: 'translate-selection-at', text: info.selectionText || '' }).catch(() => {});
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-translate') {
    sendToActiveTab('toggle-translate');
  }
});
