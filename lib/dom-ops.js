// DOM 操作纯函数模块（占位符构建 / 双语单语渲染 / 包装记录与还原）
// 供 content script 与 jsdom 测试共用；DOM 状态（origHtml/origValues）由调用方持有并传入

export const PH_OPEN = '⟪';
export const PH_CLOSE = '⟫';
export const TARGET_CLASS = 'pure-translate-target';
export const WRAP_CLASS = 'pure-translate-wrap';

// DOM 节点类型常量（避免依赖全局 Node，兼容 jsdom/node 测试环境）
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INS', 'MARK', 'Q', 'S', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'WBR']);

// 按 ⟪n⟫ 拆分译文输出
export function splitByPh(str) {
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

// 构建段落占位符原文：文本节点编入 regs（type:'text'），含图内联元素整体保留（type:'node'）
export function buildPlaceholder(el, regs, excluded) {
  let out = '';
  const walk = (container) => {
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === TEXT_NODE) {
        const v = node.nodeValue;
        if (!v.trim()) { out += ' '; continue; }
        regs.push({ type: 'text', node });
        out += PH_OPEN + (regs.length - 1) + PH_CLOSE + v;
      } else if (node.nodeType === ELEMENT_NODE) {
        if (node.tagName === 'BR') { out += '\n'; continue; }
        if (excluded(node)) continue;
        // 含图片的内联元素整体保留（图片 textContent 为空，须先于空文本检查）
        if (node.tagName === 'IMG' || node.querySelector('img')) {
          regs.push({ type: 'node', node });
          out += PH_OPEN + (regs.length - 1) + PH_CLOSE;
          continue;
        }
        const t = node.textContent || '';
        if (!t.trim()) continue;
        walk(node); // 链接/强调等内联元素：深入收集文本节点
      }
    }
  };
  walk(el);
  return out.replace(/[ \t]+/g, ' ').trim();
}

// 双语渲染：译文 <font> 插入原段落后；内联占位克隆回译文
export function renderBilingual(seg, translation, { targetClass, markMutation }) {
  const el = seg.el;
  const doc = el.ownerDocument;
  const font = doc.createElement('font');
  font.className = targetClass + (seg.isInline ? ' ' + targetClass + '--inline' : '');
  const parts = splitByPh(translation);
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.str.trim()) font.appendChild(doc.createTextNode(part.str));
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

// 单语渲染：
// - 精确路径：占位符与原文文本节点一一对齐时逐节点替换（保留内联结构）
// - 兜底路径：对不齐时整段替换为纯文本译文（绝不双语混杂）
export function renderMono(seg, translation, { markMutation, origHtml, origValues }) {
  const el = seg.el;
  const parts = splitByPh(translation);
  const textRegIdx = seg.regs.map((r, i) => (r.type === 'text' ? i : -1)).filter((i) => i >= 0);
  const phTextIdx = parts.filter((p) => p.kind === 'ph' && seg.regs[p.i]?.type === 'text').map((p) => p.i);
  if (textRegIdx.length === phTextIdx.length && textRegIdx.every((v, k) => v === phTextIdx[k])) {
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
  const plain = translation.replace(/⟪\d{1,3}⟫/g, ' ').replace(/\s+/g, ' ').trim();
  if (!plain) return false;
  markMutation();
  origHtml.set(el, el.innerHTML);
  el.replaceChildren(el.ownerDocument.createTextNode(plain));
  el.setAttribute('data-pt-mono', '1');
  return true;
}

// 混合内容容器的直接文本/内联节点就地包装为段落，并记录包装（还原时无损展开）
// 返回 [{wrapper, parent}]，按创建顺序；还原时逆序 unwrap
export function wrapDirectText(el, { excluded, addSegment }) {
  const records = [];
  let wrapper = null;
  for (const node of Array.from(el.childNodes)) {
    const isText = node.nodeType === TEXT_NODE && node.nodeValue.trim();
    const isInlineEl = node.nodeType === ELEMENT_NODE && INLINE_TAGS.has(node.tagName) && !excluded(node) && (node.textContent || '').trim() && node.tagName !== 'BR';
    if (isText || isInlineEl) {
      if (!wrapper) {
        wrapper = el.ownerDocument.createElement('span');
        wrapper.className = WRAP_CLASS;
        node.parentNode.insertBefore(wrapper, node);
        records.push({ wrapper, parent: el });
      }
      wrapper.appendChild(node);
    } else {
      // 每个包装段结束（遇到块级子元素）时注册一次
      if (wrapper) addSegment?.(wrapper);
      wrapper = null;
    }
  }
  if (wrapper) addSegment?.(wrapper);
  return records;
}

// 还原包装：逆序把 wrapper 子节点移回原位并移除 wrapper
export function unwrapRecords(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const { wrapper } = records[i];
    if (!wrapper.isConnected) continue;
    wrapper.replaceWith(...wrapper.childNodes);
  }
}
