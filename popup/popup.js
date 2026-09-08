const $ = (id) => document.getElementById(id);

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return null; // content script 未注入（chrome:// 等页面）
  }
}

function renderState(state) {
  const status = $('status');
  const toggle = $('toggle');
  const hint = $('hint');

  if (!state) {
    status.textContent = '此页面无法使用（浏览器内置页或未加载）';
    toggle.disabled = true;
    return;
  }

  toggle.disabled = false;

  if (state.translating) {
    status.textContent = `翻译中… ${state.done}/${state.total}`;
  } else if (state.active) {
    status.textContent = `已翻译 ${state.done}/${state.total} 段，点击下方按钮还原`;
  } else if (state.blacklisted) {
    status.textContent = '当前页面在排除列表中';
  } else if (state.pageLang === 'target') {
    status.textContent = '页面主要已是目标语言，仍可强制翻译';
  } else {
    status.textContent = '就绪';
  }

  toggle.textContent = state.active ? '还原页面' : '翻译当前页面';

  if (!state.hasKey) {
    hint.innerHTML = '尚未配置 API Key，<a href="#" id="go-options">去设置</a>';
    hint.querySelector('#go-options')?.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  } else {
    hint.textContent = '';
  }

  document.querySelectorAll('#mode-group button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === state.mode);
  });
}

async function refresh() {
  const tabId = await activeTabId();
  const state = tabId != null ? await sendToTab(tabId, { type: 'get-state' }) : null;
  renderState(state);
  return { tabId, state };
}

$('toggle').addEventListener('click', async () => {
  const { tabId } = await refresh();
  if (tabId == null) return;
  await sendToTab(tabId, { type: 'toggle-translate' });
  await sleep(400);
  refresh();
});

document.querySelectorAll('#mode-group button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const { tabId } = await refresh();
    await chrome.storage.local.set({ mode: btn.dataset.mode });
    if (tabId != null) {
      await sendToTab(tabId, { type: 'set-mode', mode: btn.dataset.mode });
    }
    await sleep(400);
    refresh();
  });
});

$('target-lang').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ targetLang: e.target.value });
  refresh();
});

$('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const stored = await chrome.storage.local.get(['targetLang', 'mode']);
  if (stored.targetLang) $('target-lang').value = stored.targetLang;
  await refresh();
  // 翻译期间轮询进度
  const timer = setInterval(refresh, 800);
  window.addEventListener('unload', () => clearInterval(timer));
})();
