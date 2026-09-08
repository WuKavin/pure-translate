import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranslationResponse,
  detectRole,
  buildSystemPrompt,
  buildUserPrompt,
  ROLES,
} from '../lib/prompts.js';

test('严格模式：按 ⟦n⟧ 解析', () => {
  const out = parseTranslationResponse('⟦1⟧你好世界\n⟦2⟧第二段', 2);
  assert.deepEqual(out, ['你好世界', '第二段']);
});

test('严格模式：译文多行且含占位符', () => {
  const out = parseTranslationResponse('⟦1⟧第一行\n第二行 ⟪0⟫ 结束\n⟦2⟧尾段', 2);
  assert.equal(out[0], '第一行\n第二行 ⟪0⟫ 结束');
  assert.equal(out[1], '尾段');
});

test('严格模式：缺失编号留空', () => {
  const out = parseTranslationResponse('⟦1⟧只有一段', 3);
  assert.equal(out[0], '只有一段');
  assert.equal(out[1], null);
  assert.equal(out[2], null);
});

test('严格模式：编号乱序按位置回填', () => {
  const out = parseTranslationResponse('⟦2⟧乙\n⟦1⟧甲', 2);
  assert.equal(out[0], '甲');
  assert.equal(out[1], '乙');
});

test('宽松模式回退：行首编号', () => {
  const out = parseTranslationResponse('1. 你好\n2. 世界\n3. 第三', 3);
  assert.deepEqual(out, ['你好', '世界', '第三']);
});

test('宽松模式回退：带括号变体', () => {
  const out = parseTranslationResponse('[1] 你好\n[2] 世界', 2);
  assert.deepEqual(out, ['你好', '世界']);
});

test('严格解析覆盖不足 60% 时回退宽松', () => {
  // 3 段只严格命中 1 段（<60%），回退宽松后全部命中
  const out = parseTranslationResponse('⟦1⟧甲\n2. 乙\n3. 丙', 3);
  assert.deepEqual(out, ['甲', '乙', '丙']);
});

test('空输入返回全 null', () => {
  assert.deepEqual(parseTranslationResponse('', 2), [null, null]);
  assert.deepEqual(parseTranslationResponse('模型拒答内容无编号', 2), [null, null]);
});

test('detectRole：域名路由', () => {
  assert.equal(detectRole('https://github.com/anomalyco/opencode'), 'technical');
  assert.equal(detectRole('https://stackoverflow.com/questions/1'), 'technical');
  assert.equal(detectRole('https://arxiv.org/abs/1234'), 'academic');
  assert.equal(detectRole('https://www.reddit.com/r/opencode/'), 'community');
  assert.equal(detectRole('https://x.com/someone/status/1'), 'community');
  assert.equal(detectRole('https://www.bbc.com/news/x'), 'news');
  assert.equal(detectRole('https://www.amazon.com/dp/B0'), 'commerce');
  assert.equal(detectRole('https://en.wikipedia.org/wiki/AI'), 'wiki');
  assert.equal(detectRole('https://example.com/page'), 'general');
  assert.equal(detectRole('not a url'), 'general');
});

test('buildSystemPrompt：包含角色与语言', () => {
  const p = buildSystemPrompt('technical', 'zh-CN', '术语 foo 保留');
  assert.ok(p.includes('技术文档'));
  assert.ok(p.includes('简体中文'));
  assert.ok(p.includes('命令行、代码'));
  assert.ok(p.includes('术语 foo 保留'));
  assert.ok(p.includes('⟪0⟫'));
});

test('buildSystemPrompt：未知角色回落 general', () => {
  const p = buildSystemPrompt('no-such-role', 'ja', '');
  assert.ok(p.includes('一般网页内容'));
  assert.ok(p.includes('日本語'));
});

test('buildUserPrompt：标题、类型与编号段落', () => {
  const p = buildUserPrompt('My Page', '技术文档', ['Hello world', 'Second'], 'zh-CN');
  assert.ok(p.includes('<page>'));
  assert.ok(p.includes('页面标题: My Page'));
  assert.ok(p.includes('⟦1⟧Hello world'));
  assert.ok(p.includes('⟦2⟧Second'));
});

test('ROLES 完整性：7 个角色均有 label 与 extra', () => {
  for (const key of ['general', 'technical', 'academic', 'community', 'news', 'commerce', 'wiki']) {
    assert.ok(ROLES[key]?.label, key);
    assert.ok(ROLES[key]?.extra?.length > 10, key);
  }
});

const hasSubtle = typeof globalThis.crypto?.subtle?.digest === 'function';

test('sha256hex：确定性、64 位十六进制、区分不同输入', { skip: !hasSubtle && '环境无 crypto.subtle' }, async () => {
  const { sha256hex } = await import('../lib/prompts.js');
  const a1 = await sha256hex('hello world');
  const a2 = await sha256hex('hello world');
  const b = await sha256hex('hello worlc');
  assert.equal(a1, a2);
  assert.equal(a1.length, 64);
  assert.match(a1, /^[0-9a-f]{64}$/);
  assert.notEqual(a1, b);
  assert.equal(await sha256hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('buildCacheKey：各维度参与且相互区分', { skip: !hasSubtle && '环境无 crypto.subtle' }, async () => {
  const { buildCacheKey } = await import('../lib/prompts.js');
  const base = { model: 'deepseek-v4-flash', lang: 'zh-CN', role: 'technical', extra: '', text: 'Hello' };
  const k0 = await buildCacheKey('pt-cache2:', base);
  assert.ok(k0.startsWith('pt-cache2:deepseek-v4-flash|zh-CN|technical|'));
  assert.ok(k0.endsWith(await buildCacheKey('pt-cache2:', base).then((k) => k.split('|').pop())));

  // 换模型 / 语言 / 角色 / 附加指令 / 文本 → key 全部不同
  assert.notEqual(k0, await buildCacheKey('pt-cache2:', { ...base, model: 'glm-5.3-flash' }));
  assert.notEqual(k0, await buildCacheKey('pt-cache2:', { ...base, lang: 'zh-TW' }));
  assert.notEqual(k0, await buildCacheKey('pt-cache2:', { ...base, role: 'academic' }));
  assert.notEqual(k0, await buildCacheKey('pt-cache2:', { ...base, extra: '术语 foo 保留' }));
  assert.notEqual(k0, await buildCacheKey('pt-cache2:', { ...base, text: 'World' }));

  // 空指令与未传（undefined）等价 → 命中同一缓存
  assert.equal(
    await buildCacheKey('pt-cache2:', base),
    await buildCacheKey('pt-cache2:', { ...base, extra: undefined })
  );
});
