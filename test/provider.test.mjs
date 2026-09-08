import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_DEFS,
  DEFAULT_PROVIDERS,
  normalizeSettings,
  resolveActiveProvider,
} from '../lib/provider.js';

test('normalizeSettings：旧扁平结构迁移', () => {
  const out = normalizeSettings({
    apiKey: 'sk-old',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'glm-5.3-flash',
  });
  assert.equal(out.provider, 'opencode');
  assert.equal(out.providers.opencode.apiKey, 'sk-old');
  assert.equal(out.providers.opencode.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(out.models.opencode, 'glm-5.3-flash');
  assert.equal(out.providers.lmstudio.baseUrl, 'http://localhost:1234/v1');
  assert.deepEqual(Object.keys(out.providers), ['opencode', 'lmstudio', 'custom']);
});

test('normalizeSettings：新结构原样保留', () => {
  const s = {
    provider: 'lmstudio',
    providers: { lmstudio: { baseUrl: 'http://localhost:9999/v1', apiKey: '' } },
    models: { lmstudio: 'qwen3.5-4b' },
  };
  const out = normalizeSettings(s);
  assert.equal(out.providers.lmstudio.baseUrl, 'http://localhost:9999/v1');
  assert.equal(out.models.lmstudio, 'qwen3.5-4b');
  assert.equal(out.provider, 'lmstudio');
});

test('normalizeSettings：空输入给默认', () => {
  const out = normalizeSettings({});
  assert.equal(out.provider, 'opencode');
  assert.deepEqual(out.providers, DEFAULT_PROVIDERS);
  assert.equal(out.models.opencode, 'deepseek-v4-flash');
});

test('resolveActiveProvider：opencode 默认', () => {
  const cfg = resolveActiveProvider({ apiKey: 'sk-1', model: 'glm-5.3-flash' });
  assert.equal(cfg.id, 'opencode');
  assert.equal(cfg.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(cfg.apiKey, 'sk-1');
  assert.equal(cfg.model, 'glm-5.3-flash');
  assert.equal(cfg.isOpencode, true);
  assert.equal(cfg.isLocal, false);
  assert.equal(cfg.needsKey, true);
});

test('resolveActiveProvider：lmstudio 本地、无需 key', () => {
  const cfg = resolveActiveProvider(normalizeSettings({
    provider: 'lmstudio',
    providers: { lmstudio: { baseUrl: 'http://localhost:1234/v1', apiKey: '' } },
    models: { lmstudio: 'qwen3.5-4b' },
  }));
  assert.equal(cfg.id, 'lmstudio');
  assert.equal(cfg.isLocal, true);
  assert.equal(cfg.isOpencode, false);
  assert.equal(cfg.needsKey, false);
  assert.equal(cfg.model, 'qwen3.5-4b');
});

test('resolveActiveProvider：baseUrl 尾斜杠清理与本地判定', () => {
  const cfg = resolveActiveProvider(normalizeSettings({
    provider: 'custom',
    providers: { custom: { baseUrl: 'http://127.0.0.1:8080/v1/', apiKey: '' } },
    models: { custom: 'm' },
  }));
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:8080/v1');
  assert.equal(cfg.isLocal, true);
  assert.equal(cfg.id, 'custom');
});

test('PROVIDER_DEFS 完整性：三个供应商均有 label 与默认地址', () => {
  for (const id of ['opencode', 'lmstudio', 'custom']) {
    assert.ok(PROVIDER_DEFS[id]?.label, id);
    assert.equal(typeof PROVIDER_DEFS[id].needsKey, 'boolean');
  }
  assert.equal(PROVIDER_DEFS.lmstudio.defaultBaseUrl, 'http://localhost:1234/v1');
});
