// 文本语言判断与过滤（纯逻辑，供 content script 与 node 测试共用）
// 修复要点（Code Review P1-2）：
// 1. 补 Cyrillic 文字统计（此前俄语等西里尔文本被当无效文本跳过）
// 2. 同文字系统不能当作同语言：latin→latin 不做本地"已是目标语言"跳过（保守翻译，交给模型判断）
// 3. 简繁中文、中文→日语做语言级判断（特征字表 / 假名占比）

// 简体↔繁体异形高频特征字（两表按序对应）
const SIMP = '这国个对说们来为学时电长进问张图动从关开体现实发还过报气门头见经当条里点让办样只许';
const TRAD = '這國個對說們來為學時電長進問張圖動從關開體現實發還過報氣門頭見經當條裡點讓辦樣只許';

function zhVariant(text) {
  let s = 0;
  let t = 0;
  for (const ch of text) {
    if (SIMP.includes(ch)) s++;
    else if (TRAD.includes(ch)) t++;
  }
  if (s === 0 && t === 0) return 'unknown';
  if (t > s) return 'traditional';
  if (s > t) return 'simplified';
  return 'unknown';
}

// 文字统计：CJK / 拉丁（含扩展）/ 假名 / 谚文 / 西里尔
export function textStats(text) {
  let cjk = 0, latin = 0, kana = 0, hangul = 0, cyrillic = 0, valid = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) { cjk++; valid++; }
    else if (c >= 0x3040 && c <= 0x30ff) { kana++; valid++; }
    else if (c >= 0xac00 && c <= 0xd7af) { hangul++; valid++; }
    else if (c >= 0x0400 && c <= 0x052f) { cyrillic++; valid++; }
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) { latin++; valid++; }
  }
  return { cjk, latin, kana, hangul, cyrillic, valid, total: [...text].length };
}

// 是否因「已是目标语言」而跳过翻译
export function alreadyTargetLang(text, lang) {
  const stats = textStats(text);
  const v = Math.max(stats.valid, 1);
  if (lang.startsWith('zh')) {
    if (stats.cjk / v < 0.5) return false; // 主体不是汉字 → 需要翻译
    const variant = zhVariant(text);
    if (lang === 'zh-TW') return variant === 'traditional';
    return variant === 'simplified'; // zh-CN 及默认
  }
  if (lang === 'ja') {
    // 含假名判定为日语；纯汉字无假名视为中文等，继续翻译
    return stats.kana > 0;
  }
  if (lang === 'ko') return stats.hangul / v >= 0.5;
  if (lang === 'ru') return stats.cyrillic / v >= 0.6;
  // latin 目标（en/es/fr/de/pt 等）：同一文字系统无法可靠区分，
  // 保守策略：不做本地跳过，交给模型「已是目标语言则原样输出」规则兜底
  return false;
}

// 文本内容无效（无需翻译）的原因：长度/纯符号/URL/邮箱/标识符/版本号
export function invalidText(text) {
  if (text.length < 3) return 'too-short';
  if (text.length > 4000) return 'too-long';
  const stats = textStats(text);
  if (stats.valid < 3) return 'no-words';
  if (stats.valid / Math.max(stats.total, 1) < 0.3) return 'mostly-symbols';
  if (/^(https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+)$/.test(text)) return 'url-or-email';
  if (!/\s/.test(text) && /[_.-]/.test(text) && /^[A-Za-z0-9_./:\-~@+#]+$/.test(text) && /[a-z][A-Z]|[_.-]/.test(text)) return 'identifier';
  if (/^v?\d+(\.\d+)+/.test(text) && text.length < 20) return 'version';
  return null;
}

// 页面级语言提示（popup 用）：目标文字系统占比
export function targetRatio(stats, lang) {
  const v = Math.max(stats.valid, 1);
  if (lang.startsWith('zh')) return stats.cjk / v;
  if (lang === 'ja') return (stats.kana + stats.cjk) / v;
  if (lang === 'ko') return stats.hangul / v;
  if (lang === 'ru') return stats.cyrillic / v;
  return stats.latin / v;
}
