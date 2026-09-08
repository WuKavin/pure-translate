// Content Script：段落提取、智能跳过、双语/单语渲染、动态内容观察
(() => {
  'use strict';

  const TARGET_CLASS = 'pure-translate-target';
  const PH_OPEN = '⟪';
  const PH_CLOSE = '⟫';
  const MAX_SEG_CHARS = 4000;

  const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY']);
  const BLOCK_LIKE = new Set([...BLOCK_TAGS, 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'UL', 'OL', 'TABLE', 'TR', 'FORM', 'FIELDSET', 'DETAILS', 'DL', 'FIGURE', 'ADDRESS', 'CENTER']);
  const NESTED_BLOCK_SELECTOR = [...BLOCK_LIKE].join(',');
  const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INS', 'MARK', 'Q', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'WBR']);
  const EXCLUDE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'CANVAS', 'SVG', 'MATH', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'VIDEO', 'AUDIO', 'PICTURE', 'SOURCE', 'TEMPLATE', 'OBJECT', 'EMBED', 'DIALOG', 'XMP', 'PLAINTEXT', 'LABEL', 'LEGEND']);

  // ---------- 状态 ----------
  let settings = null;
  let active = false;
  let translating = false;
  let mode = 'bilingual';
  let doneCount = 0;
  let totalCount = 0;
  let failCount = 0;
  let gen = 0; // 会话代际：还原/切换时递增，旧异步回调据此中止
  let observer = null;
  let observerTimer = 0;
  let internalMutationUntil = 0;
  let blacklisted = false;
  let pageLangCache = 'unknown';
  const sessionUuid = crypto.randomUUID();

  const origHtml = new WeakMap(); // 单语还原用
  const pageMemo = new Map(); // 本页内存缓存 phText -> 译文
  let excludeSelector = '';

  function rebuildExcludeSelector() {
    const list = (settings?.cssExclude || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const valid = [];
    for (const sel of list) {
      try { document.createDocumentFragment().querySelector(sel); valid.push(sel); } catch { /* 非法选择器忽略 */ }
    }
    excludeSelector = valid.join(',');
  }

  // ---------- 排除判断 ----------
  // getComputedStyle 结果缓存（借鉴 kiss-translator displayCache，避免反复强制样式计算）
  const displayCache = new WeakMap();
  function displayOf(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      d = getComputedStyle(el);
      displayCache.set(el, d);
    }
    return d;
  }

  // 轻量检查：遍历阶段使用（无 getComputedStyle，避免强制样式计算）
  function excludedQuick(el) {
    if (EXCLUDE_TAGS.has(el.tagName)) return true;
    if (el.closest('code,pre,kbd,samp,var,button,[contenteditable="true"],noscript,template')) return true;
    if (el.classList.contains('notranslate') || el.getAttribute('translate') === 'no') return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.closest('[data-pt-src],[data-pt-mono],.pure-translate-target')) return true;
    if (excludeSelector) {
      try { if (el.closest(excludeSelector)) return true; } catch { /* ignore */ }
    }
    return false;
  }

  // 完整检查（含可见性）：仅对最终候选段落调用
  function isExcludedDeep(el) {
    if (excludedQuick(el)) return true;
    const style = displayOf(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
    if (el.getClientRects().length === 0) return true;
    return false;
  }

  // ---------- 文字统计与有效性 ----------
  function textStats(text) {
    let cjk = 0, latin = 0, kana = 0, hangul = 0, valid = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) { cjk++; valid++; }
      else if (c >= 0x3040 && c <= 0x30ff) { kana++; valid++; }
      else if (c >= 0xac00 && c <= 0xd7af) { hangul++; valid++; }
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) { latin++; valid++; }
    }
    return { cjk, latin, kana, hangul, valid, total: [...text].length };
  }

  function targetRatio(stats, lang) {
    const v = Math.max(stats.valid, 1);
    if (lang.startsWith('zh')) return stats.cjk / v;
    if (lang === 'ja') return (stats.kana + stats.cjk) / v;
    if (lang === 'ko') return stats.hangul / v;
    return stats.latin / v;
  }

  function segmentText(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 智能跳过：按钮/链接短文本、导航项、纯符号、标识符、已是目标语言
  function isSkippable(el, text, lang) {
    if (text.length < 3) return true;
    if (text.length > MAX_SEG_CHARS) return true;
    const stats = textStats(text);
    if (stats.valid < 3) return true; // 纯数字/符号
    if (stats.valid / Math.max(stats.total, 1) < 0.3) return true; // 符号占比过高
    if (targetRatio(stats, lang) >= 0.6) return true; // 已是目标语言
    if (/^(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+)$/.test(text)) return true; // URL / 邮箱
    if (!/\s/.test(text) && /[_.-]/.test(text) && /^[A-Za-z0-9_./:\-~@+#]+$/.test(text) && /[a-z][A-Z]|[_.-]/.test(text)) return true; // 标识符
    if (/^v?\d+(\.\d+)+/.test(text) && text.length < 20) return true; // 版本号

    // UI 启发式：不强行翻译按钮、短链接、导航项
    if (el.closest('nav,header,footer,aside,[role="navigation"],[role="menubar"],[role="menu"]') && text.length <= 30) return true;
    if (el.closest('a,[role="button"]') && text.length <= 20) return true;
    if (el.closest('label,summary[aria-expanded]')) return true;
    if (text.length <= 12 && text === text.toUpperCase() && /^[A-Z0-9\s&/|.'\-+]+$/.test(text)) return true;
    return false;
  }

  function globToRegex(glob) {
    const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try { return new RegExp('^' + esc + '$'); } catch { return null; }
  }

  function isBlacklisted() {
    const list = settings?.urlBlacklist || [];
    return list.some((g) => {
      const re = globToRegex(g.trim());
      return re && re.test(location.href);
    });
  }

  // ---------- 占位符构建 ----------
  function buildPlaceholder(el, regs) {
    let out = '';
    const walk = (container) => {
      for (const node of Array.from(container.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const v = node.nodeValue;
          if (!v.trim()) { out += ' '; continue; }
          regs.push({ type: 'text', node });
          out += PH_OPEN + (regs.length - 1) + PH_CLOSE + v;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === 'BR') { out += '\n'; continue; }
          if (excludedQuick(node)) continue;
          const t = node.textContent || '';
          if (!t.trim()) continue;
          if (node.tagName === 'IMG' || node.querySelector('img')) {
            // 含图片的内联元素整体保留（图片不翻译）
            regs.push({ type: 'node', node });
            out += PH_OPEN + (regs.length - 1) + PH_CLOSE;
          } else {
            // 链接/强调等内联元素：深入收集其文本节点，保证链接文字也被翻译
            // （此前 ≤40 字符的链接整体保留，导致 GitHub 文件列表/标题/链接列表整段漏翻）
            walk(node);
          }
        }
      }
    };
    walk(el);
    return out.replace(/[ \t]+/g, ' ').trim();
  }

  function splitByPh(str) {
    const parts = [];
    const re = /⟪(\d{1,3})⟫/g;
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) parts.push({ kind: 'text', str: str.slice(last, m.index) });
      parts.push({ kind: 'ph', i: parseInt(m[1], 10) });
      last = re.lastIndex;
    }
    if (last < str.length) parts.push({ kind: 'text', str: str.slice(last) });
    return parts;
  }

  // ---------- 收集段落（单次下降，无全页扫描） ----------
  function collectSegments(root, lang) {
    const segments = [];
    const seen = new WeakSet();

    const addSegment = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      if (!el.isConnected) return;
      if (isExcludedDeep(el)) return; // getComputedStyle 只发生在最终候选上
      const text = segmentText(el);
      if (isSkippable(el, text, lang)) return;
      const regs = [];
      const phText = buildPlaceholder(el, regs);
      if (!phText || !phText.trim()) return;
      if (regs.every((r) => r.type === 'node')) return;
      const isInline = /^inline$/.test(displayOf(el).display);
      segments.push({ el, phText, regs, isInline });
    };

    const wrapDirectText = (el) => {
      let wrapper = null;
      for (const node of Array.from(el.childNodes)) {
        const isText = node.nodeType === Node.TEXT_NODE && node.nodeValue.trim();
        const isInlineEl = node.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(node.tagName) && !excludedQuick(node) && (node.textContent || '').trim() && node.tagName !== 'BR';
        if (isText || isInlineEl) {
          if (!wrapper) {
            wrapper = document.createElement('span');
            wrapper.className = 'pure-translate-wrap';
            node.parentNode.insertBefore(wrapper, node);
          }
          wrapper.appendChild(node);
        } else {
          wrapper = null;
        }
      }
      if (wrapper) addSegment(wrapper);
    };

    const processBlock = (el) => {
      const nested = el.querySelector(NESTED_BLOCK_SELECTOR); // 原生查询，首个命中即停
      if (nested && !excludedQuick(nested)) {
        wrapDirectText(el);
        for (const child of Array.from(el.children)) {
          if (excludedQuick(child)) continue;
          if (BLOCK_TAGS.has(child.tagName)) processBlock(child);
          else walk(child);
        }
      } else {
        addSegment(el);
      }
    };

    const walk = (el) => {
      for (const child of Array.from(el.children)) {
        if (excludedQuick(child)) continue;
        if (BLOCK_TAGS.has(child.tagName)) { processBlock(child); continue; }
        if (child.querySelector(NESTED_BLOCK_SELECTOR)) { walk(child); continue; }
        if ((child.textContent || '').trim()) addSegment(child);
      }
    };

    if (root instanceof Element) {
      if (excludedQuick(root)) return segments;
      processBlock(root);
    } else {
      walk(root);
    }
    return segments;
  }

  // ---------- 进度角标 ----------
  let badgeEl = null;
  let badgeTimer = 0;

  function ensureBadge() {
    if (badgeEl && badgeEl.isConnected) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.className = 'pure-translate-badge';
    badgeEl.innerHTML = '<span class="ptb-spin"></span><span class="ptb-text"></span>';
    badgeEl.addEventListener('click', () => {
      if (badgeEl?.classList.contains('ptb-error')) hideBadge();
    });
    document.documentElement.appendChild(badgeEl);
    return badgeEl;
  }

  function setBadge(text, state) {
    const b = ensureBadge();
    b.classList.toggle('ptb-error', state === 'error');
    b.classList.toggle('ptb-done', state === 'done');
    b.querySelector('.ptb-spin')?.classList.toggle('ptb-hidden', state === 'done' || state === 'error');
    b.querySelector('.ptb-text').textContent = text;
    clearTimeout(badgeTimer);
    if (state === 'done') {
      badgeTimer = setTimeout(hideBadge, 2500);
    }
    // error 态不自动消失（避免用户错过失败信息），点击角标关闭
  }

  function hideBadge() {
    badgeEl?.remove();
    badgeEl = null;
  }

  function refreshBadge() {
    if (!active && !translating) return;
    if (translating) {
      setBadge(`翻译中 ${doneCount}/${totalCount}`);
    } else if (failCount > 0) {
      setBadge(`已翻译 ${doneCount}/${totalCount} 段，${failCount} 段失败保留原文，点击关闭`, 'error');
    } else if (pendingSegs.length > 0) {
      setBadge(`✓ 已翻译 ${doneCount}/${totalCount} 段，滚动自动续译`, 'done');
    } else {
      setBadge(`✓ 已翻译 ${doneCount} 段`, 'done');
    }
  }

  // ---------- 渲染 ----------
  // ---------- 渲染队列（借鉴 ReadFrog batchDOMOperation：rAF 合帧，所有译文 DOM 写每帧最多一批） ----------
  const renderQueue = [];
  let renderRaf = 0;

  function queueRender(fn) {
    renderQueue.push(fn);
    if (!renderRaf) {
      renderRaf = requestAnimationFrame(() => {
        renderRaf = 0;
        const ops = renderQueue.splice(0);
        for (const op of ops) {
          try { op(); } catch (err) { console.warn('[PureTranslate] 渲染失败:', err); }
        }
      });
    }
  }

  function markMutation() {
    internalMutationUntil = Date.now() + 200;
  }

  function renderBilingual(seg, translation) {
    const el = seg.el;
    const font = document.createElement('font');
    const style = 'pt-style-' + (settings?.bilingualStyle || 'soft');
    font.className = TARGET_CLASS + (seg.isInline ? ' ' + TARGET_CLASS + '--inline' : '') + ' ' + style;
    const parts = splitByPh(translation);
    for (const part of parts) {
      if (part.kind === 'text') {
        if (part.str.trim()) font.appendChild(document.createTextNode(part.str));
      } else {
        const reg = seg.regs[part.i];
        if (reg && reg.type === 'node') {
          font.appendChild(reg.node.cloneNode(true));
        }
      }
    }
    markMutation();
    el.setAttribute('data-pt-src', '1');
    el.insertAdjacentElement('afterend', font);
    return true;
  }

  function renderMono(seg, translation) {
    const el = seg.el;
    const parts = splitByPh(translation);
    const textRegIdx = seg.regs.map((r, i) => (r.type === 'text' ? i : -1)).filter((i) => i >= 0);
    const phTextIdx = parts.filter((p) => p.kind === 'ph' && seg.regs[p.i]?.type === 'text').map((p) => p.i);
    if (textRegIdx.length === phTextIdx.length && textRegIdx.every((v, k) => v === phTextIdx[k])) {
      // 精确路径：占位符与原文结构对齐，逐文本节点替换，保留链接/加粗等内联结构
      markMutation();
      origHtml.set(el, el.innerHTML);
      let current = -1;
      for (const part of parts) {
        if (part.kind === 'ph') {
          const reg = seg.regs[part.i];
          current = reg.type === 'text' ? part.i : -1;
        } else if (part.kind === 'text' && current >= 0) {
          const reg = seg.regs[current];
          if (!origValues.has(reg.node)) origValues.set(reg.node, reg.node.nodeValue);
          if (part.str) reg.node.nodeValue = part.str;
          current = -1;
        }
      }
      el.setAttribute('data-pt-mono', '1');
      return true;
    }
    // 兜底路径：占位符对不齐时整段替换为纯文本译文（绝不显示双语混杂）
    const plain = translation.replace(/⟪\d{1,3}⟫/g, ' ').replace(/\s+/g, ' ').trim();
    if (!plain) return false;
    markMutation();
    origHtml.set(el, el.innerHTML);
    el.replaceChildren(document.createTextNode(plain));
    el.setAttribute('data-pt-mono', '1');
    return true;
  }

  // ---------- 翻译调度 ----------
  function makeBatches(segments, batchSize) {
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const seg of segments) {
      const len = seg.phText.length;
      if (cur.length >= batchSize || (cur.length > 0 && curChars + len > 6000)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(seg);
      curChars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function runPool(tasks, limit, myGen = gen) {
    const queue = [...tasks];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
      while (queue.length) {
        const t = queue.shift();
        if (!active || gen !== myGen) return; // 已还原/切换会话，中止剩余批次
        try { await t(); } catch (err) { console.warn('[PureTranslate] 批次失败:', err); }
      }
    });
    await Promise.all(workers);
  }

  // 失败段落延迟重试一次（429 限流错峰），重试仍失败才计入失败数
  function handleBatchFailure(segs) {
    const myGen = gen;
    const retry = segs.filter((s) => !s.done && !s.retried);
    failCount += segs.length - retry.length;
    if (!retry.length) { refreshBadge(); return; }
    retry.forEach((s) => { s.retried = true; });
    setTimeout(() => {
      if (!active || gen !== myGen) return;
      pendingSegs.push(...retry);
      scheduleFlush();
    }, 2500 + Math.random() * 1500);
  }

  async function translateBatch(batch, lang, roleOverride) {
    if (!active) return;
    const todo = [];
    for (const seg of batch) {
      if (seg.done) continue;
      const hit = pageMemo.get(seg.phText);
      if (hit != null) applyTranslation(seg, hit, lang);
      else todo.push(seg);
    }
    if (!todo.length) return;

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'translate-batch',
        texts: todo.map((s) => s.phText),
        title: document.title,
        url: location.href,
        sessionId: sessionUuid,
        targetLang: lang,
        roleOverride,
        extraInstruction: settings?.extraInstruction || '',
      });
    } catch (err) {
      console.warn('[PureTranslate] 消息发送失败:', err);
      handleBatchFailure(todo);
      return;
    }
    if (!resp?.ok) {
      console.warn('[PureTranslate] 翻译失败:', resp?.errorText || resp?.error);
      if (resp?.error === 'NO_API_KEY') {
        active = false;
        setBadge('翻译失败：未配置 API Key', 'error');
        return;
      }
      handleBatchFailure(todo);
      return;
    }
    const missing = [];
    todo.forEach((seg, i) => {
      const t = resp.translations?.[i];
      if (typeof t === 'string' && t) {
        pageMemo.set(seg.phText, t);
        applyTranslation(seg, t, lang);
      } else {
        missing.push(seg);
      }
    });
    if (missing.length) handleBatchFailure(missing);
    refreshBadge();
  }

  const origValues = new WeakMap();

  function applyTranslation(seg, translation, lang) {
    void lang;
    if (!active || seg.done) return;
    seg.done = true;
    doneCount++;
    queueRender(() => {
      if (!active) return; // 已还原
      if (mode === 'mono') {
        renderMono(seg, translation); // 内部自带兜底：对不齐时整段纯文本，绝不双语混杂
      } else {
        renderBilingual(seg, translation);
      }
    });
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(null);
    return {
      apiKey: '', baseUrl: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash',
      targetLang: 'zh-CN', mode: 'bilingual', roleOverride: 'auto', extraInstruction: '',
      batchSize: 12, concurrency: 2, urlBlacklist: [], cssExclude: '', reasoning: 'off',
      bilingualStyle: 'soft', bilingualCss: '', ...stored,
    };
  }

  // ---------- 译文自定义样式注入 ----------
  function applyCustomStyle() {
    const css = (settings?.bilingualCss || '').trim().slice(0, 8192);
    let el = document.getElementById('pure-translate-custom-style');
    if (!css) { el?.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = 'pure-translate-custom-style';
      document.documentElement.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  // 设置变更时：刷新已渲染译文的主题 class + 自定义样式
  function applyStyleUpdate() {
    applyCustomStyle();
    const cls = 'pt-style-' + (settings?.bilingualStyle || 'soft');
    document.querySelectorAll('.' + TARGET_CLASS).forEach((f) => {
      f.classList.remove(...[...f.classList].filter((c) => c.startsWith('pt-style-')));
      f.classList.add(cls);
    });
  }

  // ---------- 视口优先调度（借鉴 ReadFrog IntersectionObserver 门控） ----------
  let pendingSegs = []; // 待翻译段落（文档序）
  let io = null;
  let flushTimer = 0;
  const segByEl = new WeakMap();

  function registerSegments(segs) {
    if (!segs.length) return;
    for (const s of segs) {
      s.near = false;
      segByEl.set(s.el, s);
    }
    pendingSegs.push(...segs);
    totalCount += segs.length;
    if (!io) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const s = segByEl.get(e.target);
            if (s) s.near = true;
          }
        }
        scheduleFlush();
      }, { rootMargin: '600px 0px' });
    }
    for (const s of segs) io.observe(s.el);
    scheduleFlush();
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushQueue(); }, 250);
  }

  async function flushQueue() {
    if (!active || translating) return;
    const myGen = gen;
    // 只翻译视口附近（rootMargin 600px 内）的段落：滚不到的部分不发请求
    const near = pendingSegs.filter((s) => s.near);
    if (!near.length) return;
    // 每轮最多 2 批在途，按文档序发出，保证输出基本从上到下
    const chosen = near.slice(0, Math.max(2, settings?.batchSize || 12) * 2);
    const chosenSet = new Set(chosen);
    pendingSegs = pendingSegs.filter((s) => !chosenSet.has(s));

    translating = true;
    refreshBadge();
    const lang = settings?.targetLang || 'zh-CN';
    const batches = makeBatches(chosen, Math.max(2, settings?.batchSize || 12));
    await runPool(batches.map((b) => () => translateBatch(b, lang, settings?.roleOverride)), Math.max(1, settings?.concurrency || 2), myGen);
    if (gen !== myGen) return; // 期间发生了还原/模式切换，新会话已接管
    translating = false;
    refreshBadge();
    if (active && pendingSegs.some((s) => s.near)) scheduleFlush();
  }

  async function startTranslate() {
    if (translating || active) return;
    settings = await loadSettings();
    rebuildExcludeSelector();
    blacklisted = isBlacklisted();
    if (blacklisted) {
      setBadge('当前页面在排除列表中', 'error');
      return;
    }
    if (!settings.apiKey) {
      setBadge('未配置 API Key，请打开扩展设置', 'error');
      return;
    }

    mode = settings.mode || 'bilingual';
    const lang = settings.targetLang || 'zh-CN';
    const t0 = performance.now();
    const segments = collectSegments(document.body, lang);
    console.info(`[PureTranslate] 收集 ${segments.length} 个段落，耗时 ${(performance.now() - t0).toFixed(0)}ms`);
    pageLangCache = computePageLang(lang);
    if (!segments.length) {
      setBadge('未发现可翻译的段落', 'error');
      return;
    }

    translating = false;
    active = true;
    doneCount = 0;
    failCount = 0;
    totalCount = 0;
    registerSegments(segments); // 视口内段落优先翻译，滚动自动续译
    startObserver();
  }

  function restoreAll() {
    gen++;
    internalMutationUntil = Date.now() + 300;
    active = false;
    translating = false;
    pendingSegs = [];
    clearTimeout(flushTimer);
    if (renderRaf) { cancelAnimationFrame(renderRaf); renderRaf = 0; }
    renderQueue.length = 0;
    document.querySelectorAll('[data-pt-src]').forEach((el) => {
      el.removeAttribute('data-pt-src');
      const next = el.nextElementSibling;
      if (next && next.classList.contains(TARGET_CLASS)) next.remove();
    });
    document.querySelectorAll('[data-pt-mono]').forEach((el) => {
      const html = origHtml.get(el);
      if (html != null) el.innerHTML = html;
      el.removeAttribute('data-pt-mono');
    });
    hideBadge();
    if (io) { io.disconnect(); io = null; }
    if (observer) { observer.disconnect(); observer = null; }
  }

  function toggleTranslate() {
    if (active) restoreAll();
    else startTranslate().catch((err) => {
      console.warn('[PureTranslate]', err);
      setBadge('翻译启动失败：' + String(err.message || err).slice(0, 80), 'error');
    });
  }

  // ---------- 动态内容观察 ----------
  function startObserver() {
    if (observer) return;
    let pendingRoots = [];
    observer = new MutationObserver((muts) => {
      if (Date.now() < internalMutationUntil) return;
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === Node.ELEMENT_NODE && !n.classList.contains(TARGET_CLASS)) {
            pendingRoots.push(n);
          }
        }
      }
      clearTimeout(observerTimer);
      observerTimer = setTimeout(async () => {
        const roots = pendingRoots;
        pendingRoots = [];
        if (!active || translating || !roots.length) return;
        const lang = settings?.targetLang || 'zh-CN';
        const segs = [];
        for (const r of roots.slice(0, 50)) {
          if (!r.isConnected) continue;
          segs.push(...collectSegments(r, lang));
        }
        if (!segs.length) return;
        registerSegments(segs); // 视口内优先，滚动自动续译
      }, 600);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- 划词翻译浮层 ----------
  let floatEl = null;

  function closeFloat() {
    if (floatEl) { floatEl.remove(); floatEl = null; }
  }

  async function showSelectionFloat(text) {
    closeFloat();
    if (!text || !text.trim()) return;
    const box = document.createElement('div');
    box.className = 'pure-translate-float';
    box.textContent = '翻译中…';
    let x = window.innerWidth / 2 - 180;
    let y = 80;
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect.width || rect.height) {
        x = Math.min(Math.max(8, rect.left), window.innerWidth - 380);
        y = rect.bottom + 8;
      }
    }
    box.style.left = Math.max(8, x) + 'px';
    box.style.top = Math.min(y, window.innerHeight - 120) + 'px';
    document.documentElement.appendChild(box);
    floatEl = box;

    const resp = await chrome.runtime.sendMessage({
      type: 'translate-selection',
      text: text.slice(0, 3000),
      sessionId: sessionUuid,
    }).catch(() => null);

    if (!floatEl) return;
    if (resp?.ok) {
      box.textContent = '';
      const head = document.createElement('div');
      head.className = 'pure-translate-float-src';
      head.textContent = text.slice(0, 200);
      const body = document.createElement('div');
      body.className = 'pure-translate-float-res';
      body.textContent = resp.translation;
      box.append(head, body);
    } else {
      box.textContent = '翻译失败：' + (resp?.errorText || resp?.error || '未知错误');
    }
  }

  document.addEventListener('click', (e) => {
    if (floatEl && !floatEl.contains(e.target)) closeFloat();
  }, true);

  // ---------- 语言检测（缓存，避免 popup 轮询触发 reflow） ----------
  function computePageLang(lang) {
    try {
      const sample = (document.body?.innerText || '').slice(0, 4000);
      const stats = textStats(sample);
      if (stats.valid < 40) return 'unknown';
      return targetRatio(stats, lang) >= 0.5 ? 'target' : 'foreign';
    } catch {
      return 'unknown';
    }
  }

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'get-state':
        sendResponse({
          active, translating, done: doneCount, total: totalCount,
          mode, blacklisted,
          hasKey: (() => {
            const p = settings?.provider || 'opencode';
            if (p === 'lmstudio') return true; // 本地模型无需 key
            return !!settings?.providers?.[p]?.apiKey;
          })(),
          pageLang: pageLangCache,
        });
        break;
      case 'toggle-translate':
        toggleTranslate();
        sendResponse({ ok: true });
        break;
      case 'restore-page':
        restoreAll();
        sendResponse({ ok: true });
        break;
      case 'set-mode':
        (async () => {
          mode = msg.mode === 'mono' ? 'mono' : 'bilingual';
          await chrome.storage.local.set({ mode });
          if (active) {
            restoreAll();
            await startTranslate();
          }
          sendResponse({ ok: true });
        })();
        return true;
      case 'translate-selection-at':
        showSelectionFloat(msg.text || (window.getSelection()?.toString() || ''));
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
    return false;
  });

  // 初始化：预读设置
  loadSettings().then((s) => { settings = s; rebuildExcludeSelector(); applyStyleUpdate(); });
  chrome.storage.onChanged.addListener(() => {
    loadSettings().then((s) => { settings = s; rebuildExcludeSelector(); applyStyleUpdate(); });
  });
})();
