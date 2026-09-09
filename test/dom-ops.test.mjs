import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  splitByPh,
  buildPlaceholder,
  renderBilingual,
  renderMono,
  wrapDirectText,
  unwrapRecords,
  TARGET_CLASS,
} from '../lib/dom-ops.js';

const dom = new JSDOM('<html><body></body></html>');
const { document } = dom.window;
const markMutation = () => {};
const origHtml = new WeakMap();
const origValues = new WeakMap();

function fragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const el = tpl.content.firstElementChild;
  if (!el) throw new Error('fragment: no element');
  document.body.appendChild(el);
  return el;
}

test('splitByPh：文本与占位符交替', () => {
  const parts = splitByPh('你好⟪0⟫世界');
  assert.deepEqual(parts, [
    { kind: 'text', str: '你好' },
    { kind: 'ph', i: 0 },
    { kind: 'text', str: '世界' },
  ]);
});

test('buildPlaceholder：链接文本深入、图片整体保留', () => {
  const el = fragment('<p>Hello <a href="x">world</a> <img src="x"></p>');
  const regs = [];
  const phText = buildPlaceholder(el, regs, () => false);
  const textRegs = regs.filter((r) => r.type === 'text');
  const nodeRegs = regs.filter((r) => r.type === 'node');
  assert.equal(textRegs.length, 2); // "Hello " 与链接内 "world"
  assert.equal(textRegs[0].node.nodeValue.trim(), 'Hello');
  assert.equal(textRegs[1].node.nodeValue, 'world');
  assert.equal(nodeRegs.length, 1); // img 整体保留
  assert.equal(nodeRegs[0].node.tagName, 'IMG');
  assert.ok(phText.includes('⟪0⟫'));
});

test('buildPlaceholder：excluded 的 code 内容不出现在原文', () => {
  const el = fragment('<p>Run <code>npm install</code> now</p>');
  const regs = [];
  const phText = buildPlaceholder(el, regs, (n) => n.tagName === 'CODE');
  assert.ok(!phText.includes('npm install'));
  assert.equal(regs.filter((r) => r.type === 'text').length, 2);
});

test('renderBilingual：译文插入后、内联占位克隆回译文', () => {
  const el = fragment('<p>See the <a href="x">docs</a></p>');
  const a = el.querySelector('a');
  const seg = { el, isInline: false, regs: [{ type: 'node', node: a }] };
  renderBilingual(seg, '查看⟪0⟫。', { targetClass: TARGET_CLASS, markMutation });
  const font = el.nextElementSibling;
  assert.ok(font, '译文元素已插入');
  assert.ok(font.classList.contains(TARGET_CLASS));
  assert.ok(font.innerHTML.includes('查看'));
  assert.ok(font.querySelector('a'), '链接克隆回译文');
  assert.equal(el.getAttribute('data-pt-src'), '1');
});

test('renderMono 精确路径：占位符对齐时逐节点替换并保留内联结构', () => {
  const el = fragment('<p>Hello <b>world</b></p>');
  const regs = [];
  buildPlaceholder(el, regs, () => false);
  const ok = renderMono(
    { el, regs },
    regs.map((r, i) => `⟪${i}⟫` + (r.type === 'text' ? ['你好 ', '世界'][i] : '')).join(''),
    { markMutation, origHtml, origValues }
  );
  assert.ok(ok);
  assert.equal(el.textContent, '你好 世界');
  assert.ok(el.querySelector('b'), '内联结构保留');
  assert.equal(el.getAttribute('data-pt-mono'), '1');
});

test('renderMono 兜底路径：占位符对不齐时整段替换为纯文本（绝不双语混杂）', () => {
  const el = fragment('<p>Original English sentence</p>');
  const regs = [{ type: 'text', node: el.firstChild }, { type: 'node', node: document.createElement('a') }];
  const ok = renderMono(
    { el, regs },
    '没有占位符的纯译文',
    { markMutation, origHtml, origValues }
  );
  assert.ok(ok);
  assert.equal(el.textContent, '没有占位符的纯译文');
  assert.equal(el.childNodes.length, 1, '整段替换为单一文本节点');
});

test('wrap/unwrap：混合内容容器还原后 DOM 结构与初始一致（Code Review P2-2）', () => {
  const host = fragment('<div id="mix"></div>');
  host.innerHTML = 'direct <b>text</b><p>block</p>';
  const before = host.innerHTML;
  const segs = [];
  const records = wrapDirectText(host, {
    excluded: () => false,
    addSegment: (s) => segs.push(s),
  });
  assert.equal(records.length, 1);
  assert.ok(host.querySelector('span.pure-translate-wrap'), '直接文本已被包装');
  assert.equal(segs.length, 1, '包装段作为段落注册');
  assert.ok(host.querySelector(':scope > p'), '块级子元素保持原位');

  unwrapRecords(records);
  assert.equal(host.innerHTML, before, '还原后与初始 DOM 完全一致');
  assert.equal(host.querySelectorAll('span.pure-translate-wrap').length, 0);
});
