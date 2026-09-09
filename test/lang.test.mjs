import test from 'node:test';
import assert from 'node:assert/strict';
import { textStats, alreadyTargetLang, invalidText, targetRatio } from '../lib/lang.js';

test('textStats：西里尔文字计入 valid（Code Review P1-2）', () => {
  const s = textStats('Привет мир');
  assert.equal(s.cyrillic, 9);
  assert.equal(s.valid, 9);
  assert.equal(s.total, 10);
});

test('textStats：CJK / 拉丁 / 假名 / 谚文分类', () => {
  assert.deepEqual(
    { ...textStats('中文Test') },
    { cjk: 2, latin: 4, kana: 0, hangul: 0, cyrillic: 0, valid: 6, total: 6 }
  );
  assert.ok(textStats('これはテスト').kana >= 4);
  assert.ok(textStats('안녕하세요').hangul >= 4);
});

test('alreadyTargetLang：latin→latin 保守翻译（fr→en、en→es）', () => {
  assert.equal(alreadyTargetLang('Bonjour le monde', 'en'), false);
  assert.equal(alreadyTargetLang('Hello world', 'es'), false);
  assert.equal(alreadyTargetLang('Hello world', 'de'), false);
});

test('alreadyTargetLang：西里尔方向（en→ru 翻译、ru→ru 跳过、ru→zh 翻译）', () => {
  assert.equal(alreadyTargetLang('Hello world', 'ru'), false);
  assert.equal(alreadyTargetLang('Привет мир', 'ru'), true);
  assert.equal(alreadyTargetLang('Привет мир', 'zh-CN'), false);
});

test('alreadyTargetLang：简繁中文', () => {
  assert.equal(alreadyTargetLang('这个世界真好', 'zh-CN'), true); // 简体→简体跳过
  assert.equal(alreadyTargetLang('这个世界真好', 'zh-TW'), false); // 简体→繁体需翻译
  assert.equal(alreadyTargetLang('這個世界真好', 'zh-TW'), true); // 繁体→繁体跳过
  assert.equal(alreadyTargetLang('這個世界真好', 'zh-CN'), false); // 繁体→简体需翻译
});

test('alreadyTargetLang：中文→日语（纯汉字需翻译，含假名跳过）', () => {
  assert.equal(alreadyTargetLang('这个世界真好', 'ja'), false);
  assert.equal(alreadyTargetLang('これは世界です', 'ja'), true);
});

test('alreadyTargetLang：韩语', () => {
  assert.equal(alreadyTargetLang('안녕하세요', 'ko'), true);
  assert.equal(alreadyTargetLang('Hello world', 'ko'), false);
});

test('invalidText：URL / 邮箱 / 标识符 / 版本号 / 纯符号', () => {
  assert.ok(invalidText('https://example.com/path'));
  assert.ok(invalidText('user@example.com'));
  assert.ok(invalidText('camelCase_token'));
  assert.ok(invalidText('snake_case_token'));
  assert.ok(invalidText('v1.2.3'));
  assert.ok(invalidText('12345'));
  assert.ok(invalidText('ab'));
  assert.equal(invalidText('This is a normal sentence.'), null);
});

test('targetRatio：俄语目标的西里尔占比', () => {
  assert.ok(targetRatio(textStats('Привет мир'), 'ru') >= 0.9);
});
