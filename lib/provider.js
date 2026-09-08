// 模型供应商抽象：OpenCode Go / 本地 LM Studio / 自定义 OpenAI 兼容
// 纯函数模块，可被 service worker 与 node 测试共用

export const PROVIDER_DEFS = {
  opencode: {
    label: 'OpenCode Go（云端）',
    defaultBaseUrl: 'https://opencode.ai/zen/go/v1',
    defaultModel: 'deepseek-v4-flash',
    needsKey: true,
  },
  lmstudio: {
    label: '本地 LM Studio',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultModel: '',
    needsKey: false,
  },
  custom: {
    label: '自定义 OpenAI 兼容',
    defaultBaseUrl: '',
    defaultModel: '',
    needsKey: true,
  },
};

export const DEFAULT_PROVIDERS = {
  opencode: { baseUrl: PROVIDER_DEFS.opencode.defaultBaseUrl, apiKey: '' },
  lmstudio: { baseUrl: PROVIDER_DEFS.lmstudio.defaultBaseUrl, apiKey: '' },
  custom: { baseUrl: '', apiKey: '' },
};

export const DEFAULT_MODELS = {
  opencode: PROVIDER_DEFS.opencode.defaultModel,
  lmstudio: '',
  custom: '',
};

// 旧版扁平结构（apiKey/baseUrl/model 顶层字段）→ providers/models 迁移（幂等）
export function normalizeSettings(raw = {}) {
  const out = { ...raw };
  if (!out.providers || typeof out.providers !== 'object') {
    out.providers = {
      opencode: {
        baseUrl: raw.baseUrl || DEFAULT_PROVIDERS.opencode.baseUrl,
        apiKey: raw.apiKey || '',
      },
      lmstudio: { ...DEFAULT_PROVIDERS.lmstudio },
      custom: { ...DEFAULT_PROVIDERS.custom },
    };
  }
  if (!out.models || typeof out.models !== 'object') {
    out.models = { ...DEFAULT_MODELS, opencode: raw.model || DEFAULT_MODELS.opencode };
  }
  if (!out.provider || !PROVIDER_DEFS[out.provider]) out.provider = 'opencode';
  return out;
}

// 解析当前生效供应商的完整配置
export function resolveActiveProvider(settings = {}) {
  const s = normalizeSettings(settings);
  const id = s.provider;
  const def = PROVIDER_DEFS[id];
  const pcfg = s.providers?.[id] || {};
  const baseUrl = String(pcfg.baseUrl || def.defaultBaseUrl || '').replace(/\/+$/, '');
  const apiKey = pcfg.apiKey || '';
  const model = s.models?.[id] || def.defaultModel || '';
  const isLocal = /localhost|127\.0\.0\.1|\[::1\]|^::1/.test(baseUrl);
  return {
    id,
    label: def.label,
    baseUrl,
    apiKey,
    model,
    needsKey: def.needsKey,
    isOpencode: id === 'opencode',
    isLocal,
  };
}
