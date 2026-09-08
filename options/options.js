const $ = (id) => document.getElementById(id);

const PROVIDER_IDS = ['opencode', 'lmstudio', 'custom'];
const DEFAULTS = {
  providers: {
    opencode: { baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: '' },
    lmstudio: { baseUrl: 'http://localhost:1234/v1', apiKey: '' },
    custom: { baseUrl: '', apiKey: '' },
  },
  models: { opencode: 'deepseek-v4-flash', lmstudio: '', custom: '' },
};

const SETTINGS_KEYS = [
  'provider', 'providers', 'models',
  'targetLang', 'mode', 'roleOverride', 'extraInstruction',
  'batchSize', 'concurrency', 'reasoning', 'bilingualStyle', 'bilingualCss',
  'urlBlacklist', 'cssExclude',
];

function flash(el, text, ok = true) {
  el.textContent = text;
  el.style.color = ok ? '#1a7f37' : '#c0392b';
  setTimeout(() => { el.textContent = ''; }, 4000);
}

function showProviderGroup(id) {
  document.querySelectorAll('.provider-group').forEach((g) => {
    g.hidden = g.dataset.group !== id;
  });
}

async function load() {
  const s = await chrome.storage.local.get(null);
  const provider = s.provider || 'opencode';
  $('provider').value = provider;
  showProviderGroup(provider);

  // 兜底迁移：旧扁平结构 → 三组显示（真实写入在保存时/Service Worker 完成）
  const providers = s.providers || {
    opencode: { baseUrl: s.baseUrl || DEFAULTS.providers.opencode.baseUrl, apiKey: s.apiKey || '' },
    lmstudio: { ...DEFAULTS.providers.lmstudio },
    custom: { ...DEFAULTS.providers.custom },
  };
  const models = s.models || { opencode: s.model || DEFAULTS.models.opencode, lmstudio: '', custom: '' };

  for (const id of PROVIDER_IDS) {
    $(`base-url-${id}`).value = providers[id]?.baseUrl ?? '';
    $(`api-key-${id}`).value = providers[id]?.apiKey ?? '';
    $(`model-${id}`).value = models[id] ?? '';
  }

  $('mode').value = s.mode || 'bilingual';
  $('target-lang').value = s.targetLang || 'zh-CN';
  $('batch-size').value = s.batchSize ?? 12;
  $('concurrency').value = s.concurrency ?? 2;
  $('reasoning').value = s.reasoning || 'off';
  $('bilingual-style').value = s.bilingualStyle || 'soft';
  $('bilingual-css').value = s.bilingualCss || '';
  $('role-override').value = s.roleOverride || 'auto';
  $('extra-instruction').value = s.extraInstruction || '';
  $('url-blacklist').value = (s.urlBlacklist || []).join('\n');
  $('css-exclude').value = s.cssExclude || '';
}

async function save() {
  const provider = $('provider').value;
  const providers = {};
  const models = {};
  for (const id of PROVIDER_IDS) {
    providers[id] = {
      baseUrl: $(`base-url-${id}`).value.trim(),
      apiKey: $(`api-key-${id}`).value.trim(),
    };
    models[id] = $(`model-${id}`).value.trim();
  }
  if (!providers.opencode.baseUrl) providers.opencode.baseUrl = DEFAULTS.providers.opencode.baseUrl;
  if (!models.opencode) models.opencode = DEFAULTS.models.opencode;
  if (provider === 'lmstudio' && !providers.lmstudio.baseUrl) providers.lmstudio.baseUrl = DEFAULTS.providers.lmstudio.baseUrl;

  // 自定义/远程供应商：请求访问权限（match pattern 对应 origin，任意端口）
  const activeBase = providers[provider]?.baseUrl || '';
  if (activeBase && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(activeBase)) {
    try {
      const origin = new URL(activeBase).origin + '/*';
      const has = await chrome.permissions.contains({ origins: [origin] });
      if (!has) {
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) flash($('save-result'), '未授权访问该 API 地址，翻译请求可能失败', false);
      }
    } catch (err) {
      flash($('save-result'), '地址权限请求失败：' + String(err.message || err), false);
    }
  }

  const data = {
    provider,
    providers,
    models,
    mode: $('mode').value,
    targetLang: $('target-lang').value,
    batchSize: Math.max(2, Math.min(24, parseInt($('batch-size').value, 10) || 12)),
    concurrency: Math.max(1, Math.min(8, parseInt($('concurrency').value, 10) || 2)),
    reasoning: $('reasoning').value,
    bilingualStyle: $('bilingual-style').value,
    bilingualCss: $('bilingual-css').value.slice(0, 8192),
    roleOverride: $('role-override').value,
    extraInstruction: $('extra-instruction').value,
    urlBlacklist: $('url-blacklist').value.split('\n').map((x) => x.trim()).filter(Boolean),
    cssExclude: $('css-exclude').value,
  };
  await chrome.storage.local.set(data);
  flash($('save-result'), '已保存');
}

$('save').addEventListener('click', save);

$('provider').addEventListener('change', (e) => {
  showProviderGroup(e.target.value);
});

$('toggle-key').addEventListener('click', () => {
  const input = $('api-key-opencode');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('toggle-key').textContent = show ? '隐藏' : '显示';
});

// 当前选中供应商的表单值（获取模型列表 / 测试连接共用）
function currentProviderForm() {
  const id = $('provider').value;
  return {
    provider: id,
    baseUrl: $(`base-url-${id}`).value.trim(),
    apiKey: $(`api-key-${id}`).value.trim(),
    model: $(`model-${id}`).value.trim(),
  };
}

$('fetch-models').addEventListener('click', async () => {
  const btn = $('fetch-models');
  btn.disabled = true;
  btn.textContent = '获取中…';
  const resp = await chrome.runtime.sendMessage({ type: 'fetch-models', ...currentProviderForm() }).catch(() => null);
  btn.disabled = false;
  btn.textContent = '获取模型列表';
  const datalist = $('model-list');
  datalist.innerHTML = '';
  if (resp?.ok && resp.models?.length) {
    for (const m of resp.models) {
      const opt = document.createElement('option');
      opt.value = m;
      datalist.appendChild(opt);
    }
    flash($('test-result'), `已获取 ${resp.models.length} 个模型`);
  } else {
    flash($('test-result'), '获取失败：' + (resp?.error || '未知错误'), false);
  }
});

$('test-conn').addEventListener('click', async () => {
  const btn = $('test-conn');
  btn.disabled = true;
  btn.textContent = '测试中…';
  const resp = await chrome.runtime.sendMessage({ type: 'test-connection', ...currentProviderForm() }).catch(() => null);
  btn.disabled = false;
  btn.textContent = '测试连接';
  if (resp?.ok) {
    flash($('test-result'), '连接成功 ✓ ' + (resp.sample || ''));
  } else {
    flash($('test-result'), '连接失败：' + (resp?.error || '未知错误'), false);
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

// ---------- 配置导出 / 导入 ----------

$('export-config').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const data = {};
  for (const k of SETTINGS_KEYS) {
    if (k in all) data[k] = all[k];
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pure-translate-settings.json';
  a.click();
  URL.revokeObjectURL(url);
  flash($('save-result'), '已导出');
});

$('import-config').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const patch = {};
    for (const k of SETTINGS_KEYS) {
      if (k in data) patch[k] = data[k];
    }
    if (!Object.keys(patch).length) throw new Error('文件中没有可识别的配置项');
    await chrome.storage.local.set(patch);
    await load();
    flash($('save-result'), '配置已导入');
  } catch (err) {
    flash($('save-result'), '导入失败：' + String(err.message || err), false);
  } finally {
    e.target.value = '';
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    save();
  }
});

load();
