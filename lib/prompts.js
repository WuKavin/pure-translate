// 站点角色（翻译提示词）与批次协议模块
// 被 service worker 作为 ES module 引入

export const SEG_OPEN = '⟦';
export const SEG_CLOSE = '⟧';
export const PH_OPEN = '⟪';
export const PH_CLOSE = '⟫';

export const ROLES = {
  general: {
    label: '通用网页',
    extra: '这是一般网页内容：译文自然流畅、符合目标语言表达习惯，避免翻译腔。',
  },
  technical: {
    label: '技术文档',
    extra:
      '这是技术文档 / 开发者内容：技术术语使用业界通用译法，核心术语首次出现可保留英文原词；命令行、代码、配置键名、错误信息、HTTP 方法、文件路径、库名、API 名称一律保持原文不译。',
  },
  academic: {
    label: '学术文献',
    extra:
      '这是学术内容：术语翻译严谨规范，重要专业术语首次出现时在括号内标注英文原词；句式严谨，不口语化；公式、变量名、引用编号保持原文。',
  },
  community: {
    label: '社区论坛',
    extra:
      '这是社区 / 论坛 / 社交媒体内容：译文口语化、轻松自然；俚语和网络用语采用意译，emoji 与颜文字原样保留；@用户名、话题标签保持原文。',
  },
  news: {
    label: '新闻资讯',
    extra:
      '这是新闻报道内容：使用客观、简洁的新闻文体；机构名、地名按目标语言通用译名，人名首次出现可括注原文；数字与日期按目标语言习惯。',
  },
  commerce: {
    label: '电商产品',
    extra:
      '这是电商 / 产品营销内容：译文有吸引力、符合目标语言电商文案习惯；产品型号、SKU、规格参数、价格与货币符号保持原文。',
  },
  wiki: {
    label: '百科词条',
    extra:
      '这是百科全书内容：客观、准确、书面化；专有名词按标准译名，首次出现括注原文；参见、分类等结构保持原位。',
  },
};

// 域名 → 角色匹配规则（按顺序命中）
const DOMAIN_RULES = [
  { test: /(^|\.)github\.com$|(^|\.)gitlab\.com$|(^|\.)stackoverflow\.com$|(^|\.)stackexchange\.com$|(^|\.)developer\.mozilla\.org$|(^|\.)npmjs\.com$|(^|\.)readthedocs\.io$|(^|\.)gitbook\.io$|(^|\.)npmjs\.org$|(^|\.)pypi\.org$|(^|\.)rust-lang\.org$|(^|\.)golang\.org$|(^|\.)python\.org$|(^|\.)kernel\.org$|(^|\.)dev\.to$/, role: 'technical' },
  { test: /(^|\.)arxiv\.org$|(^|\.)\.edu$|(^|\.)\.edu\.[a-z]{2}$|(^|\.)nature\.com$|(^|\.)science\.org$|(^|\.)springer\.com$|(^|\.)ieee\.org$|(^|\.)acm\.org$|(^|\.)sciencedirect\.com$|(^|\.)semanticscholar\.org$|(^|\.)researchgate\.net$|(^|\.)biorxiv\.org$|(^|\.)medrxiv\.org$/, role: 'academic' },
  { test: /(^|\.)reddit\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)news\.ycombinator\.com$|(^|\.)v2ex\.com$|(^|\.)mastodon\.[a-z.]+$|(^|\.)bsky\.app$|(^|\.)tumblr\.com$|(^|\.)discord\.com$/, role: 'community' },
  { test: /(^|\.)nytimes\.com$|(^|\.)bbc\.com$|(^|\.)bbc\.co\.uk$|(^|\.)cnn\.com$|(^|\.)theverge\.com$|(^|\.)techcrunch\.com$|(^|\.)reuters\.com$|(^|\.)bloomberg\.com$|(^|\.)theguardian\.com$|(^|\.)apnews\.com$|(^|\.)washingtonpost\.com$|(^|\.)wsj\.com$|(^|\.)ft\.com$|(^|\.)economist\.com$|(^|\.)theatlantic\.com$|(^|\.)wired\.com$|(^|\.)arstechnica\.com$/, role: 'news' },
  { test: /(^|\.)amazon\.[a-z.]+$|(^|\.)ebay\.[a-z.]+$|(^|\.)shopify\.com$|(^|\.)temu\.com$|(^|\.)shein\.com$|(^|\.)aliexpress\.com$|(^|\.)bestbuy\.com$|(^|\.)walmart\.com$|(^|\.)etsy\.com$/, role: 'commerce' },
  { test: /(^|\.)wikipedia\.org$|(^|\.)wiktionary\.org$|(^|\.)britannica\.com$|(^|\.)fandom\.com$/, role: 'wiki' },
];

export function detectRole(url) {
  let host = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
  } catch {
    return 'general';
  }
  for (const rule of DOMAIN_RULES) {
    if (rule.test.test(host)) return rule.role;
  }
  return 'general';
}

const LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  ru: 'Русский',
  pt: 'Português',
};

export function langName(code) {
  return LANG_NAMES[code] || code || '简体中文';
}

// 所有角色共享的翻译规则
const CORE_RULES = [
  '你是一名专业译者，将网页内容翻译成{lang}。只输出译文，不解释、不加评注、不回答问题。',
  '占位符（如' + PH_OPEN + '0' + PH_CLOSE + '）代表原文中的链接、加粗、代码等内联元素，必须原样保留、位置合理，不得删除、合并或改写。',
  '专有名词处理：品牌名、产品名、人名、API 名称、代码、命令、路径、版本号、URL、邮箱、变量名保持原文不译。',
  '如果某段原文本身已经是{lang}，或内容无需翻译（纯数字、纯符号、无意义字符），原样输出该段。',
  '译文要符合{lang}的表达习惯。',
  '输出格式（严格遵守）：按输入顺序，逐条输出「' + SEG_OPEN + '编号' + SEG_CLOSE + '译文」，每条一行；不得合并、拆分、遗漏或新增编号。',
].join('\n');

export function buildSystemPrompt(roleId, targetLang, extraInstruction) {
  const role = ROLES[roleId] || ROLES.general;
  const lang = langName(targetLang);
  let p = CORE_RULES.replaceAll('{lang}', lang);
  p += '\n\n当前页面类型：' + role.label + '。' + role.extra;
  if (extraInstruction && extraInstruction.trim()) {
    p += '\n\n用户的补充翻译要求：' + extraInstruction.trim();
  }
  return p;
}

export function buildUserPrompt(title, roleLabel, segments, targetLang) {
  const lang = langName(targetLang);
  const lines = [];
  lines.push('<page>');
  if (title) lines.push('页面标题: ' + title);
  lines.push('页面类型: ' + roleLabel);
  lines.push('</page>');
  lines.push('请将以下编号段落逐条翻译成' + lang + '：');
  segments.forEach((text, i) => {
    lines.push(SEG_OPEN + (i + 1) + SEG_CLOSE + text);
  });
  return lines.join('\n');
}

// 解析模型输出：严格模式按 ⟦n⟧ 切分；覆盖不足 60% 时退回宽松的行首编号模式
export function parseTranslationResponse(text, count) {
  const result = new Array(count).fill(null);
  if (typeof text !== 'string' || !text.trim()) return result;

  const re = /⟦\s*(\d{1,4})\s*⟧/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ idx: parseInt(m[1], 10), contentStart: re.lastIndex, markerStart: m.index });
  }

  if (marks.length > 0) {
    for (let i = 0; i < marks.length; i++) {
      const segIdx = marks[i].idx;
      const from = marks[i].contentStart;
      const to = i + 1 < marks.length ? marks[i + 1].markerStart : text.length;
      const body = text.slice(from, to).trim();
      if (segIdx >= 1 && segIdx <= count && body && result[segIdx - 1] === null) {
        result[segIdx - 1] = body;
      }
    }
  }

  const filled = result.filter((x) => x !== null).length;
  if (filled < Math.ceil(count * 0.6)) {
    return parseLoose(text, count);
  }
  return result;
}

// 宽松模式：行首「1. 译文」式编号
function parseLoose(text, count) {
  const result = new Array(count).fill(null);
  const lines = text.split('\n');
  let current = -1;
  const buf = [];
  const flush = () => {
    if (current >= 1 && current <= count) {
      const joined = buf.join('\n').trim();
      if (joined && result[current - 1] === null) result[current - 1] = joined;
    }
    buf.length = 0;
  };
  for (const line of lines) {
    const m = line.match(/^\s*(?:⟦\s*(\d{1,4})\s*⟧|[\[【(（{]?\s*(\d{1,4})\s*[\]】)）}\].、:：])\s*(.*)$/);
    if (m) {
      flush();
      current = parseInt(m[1] || m[2], 10);
      buf.push(m[3]);
    } else if (current !== -1) {
      buf.push(line);
    }
  }
  flush();
  return result;
}

// ---------- 翻译缓存 key ----------

// SHA-256 十六进制摘要（加密级哈希，避免不同段落碰撞错配译文）
export async function sha256hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 缓存 key：模型/目标语言/站点角色/附加翻译要求/段落文本全部参与，
// 任一变化都会导致重新请求（不会返回与新配置不匹配的旧译文）
export async function buildCacheKey(prefix, { model, lang, role, extra, text }) {
  const instr = await sha256hex(extra || '');
  const txt = await sha256hex(text);
  return `${prefix}${model}|${lang}|${role}|${instr}|${txt}`;
}
