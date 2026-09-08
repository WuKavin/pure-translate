# 纯译 PureTranslate

极简 AI 网页翻译 Chrome 扩展。参考「沉浸式翻译」与「陪读蛙」开发，只保留网页翻译核心能力，无账号体系、无订阅、无悬浮球、无视频字幕，BYOK 直连 OpenCode Go。

## 功能

| 功能 | 说明 |
|---|---|
| 双语对照 | 译文插入原文下方，提供 5 种译文样式主题（弱化/虚线下划线/引用块/马克笔/一致）+ 自定义 CSS，原文与译文一眼可分；预设值参考沉浸式翻译样式库、kiss-translator、ReadFrog |
| 单语译文 | 译文直接替换原文，可一键还原；占位符无法对齐的复杂段落整段替换为纯文本译文，绝不出现双语混杂 |
| 智能上下文 | 每次请求携带页面标题 + 站点类型 + 同批段落，段落间译文连贯一致（内建于批次请求，无需单独开关） |
| 站点翻译角色 | 自动按域名切换提示词：技术文档 / 学术 / 社区 / 新闻 / 电商 / 百科 / 通用，可全局覆盖 |
| 智能跳过 | 专有名词、代码块、标识符（camelCase/snake_case）、URL、邮箱不翻译；独立的按钮/短链接、导航项、全大写 UI 文本不强翻；已是目标语言的段落自动跳过；段落内的链接文字跟随段落正常翻译 |
| 失败重试 | 限流/网络失败的段落自动错峰重试一次，仍失败才标记并保留原文（角标显示，点击关闭） |
| 视口优先 | 只翻译视口及滚动前方 600px 内的段落，滚不到的不发请求；每轮按文档序最多 2 批在途，输出从上到下 |
| 思考强度 | 默认关闭模型思考（`thinking: disabled`），可选低/高强度；不支持思考参数的模型自动降级重试 |
| 动态内容 | 无限滚动 / SPA 新增内容自动续译 |
| 划词翻译 | 右键「翻译选中文字」，浮层显示结果 |
| 进度角标 | 页面右下角显示翻译进度（转圈 + n/n），失败原因直接可见 |
| 缓存 | 段落级增量缓存：命中直接呈现、缺失段落才请求 LLM。key 由「模型 + 目标语言 + 站点角色 + 附加翻译要求 + 段落文本的 SHA-256」构成，任一变化自动失效；7 天 TTL + 800 条上限，跨页面复用（导航/页脚等公共段落全站只翻一次） |
| 快捷键 | `Alt+T` 翻译 / 还原当前页 |

## 安装（Chrome 加载未打包扩展）

1. 打开 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录 `pure-translate/`

## 配置模型供应商（BYOK / 本地模型）

设置页顶部选择供应商（各供应商配置独立保存，随时切换）：

### OpenCode Go（云端，默认）

1. 登录 [opencode.ai/auth](https://opencode.ai/auth)，订阅 Go 并复制 API Key（$10/月）
2. 粘贴 Key →「获取模型列表」→「测试连接」→ 保存

### 本地 LM Studio

1. LM Studio → Developer → Start Server（默认 `http://localhost:1234/v1`）
2. 设置页选「本地 LM Studio」→「获取模型列表」（列出已加载模型，如 `qwen3.5-4b`）→「测试连接」→ 保存
3. 无需 API Key；扩展已声明本地网络权限（`http://localhost/*` 通配任意端口），LM Studio 的 CORS 开关无需打开
4. 本地模型较慢：建议「每批段落数」调到 4~6、并发 1~2；思考参数不会发送给本地模型（在其应用内配置）

### 自定义 OpenAI 兼容

任意 OpenAI 兼容端点（OpenRouter / Ollama `http://localhost:11434/v1` / vLLM 等）。保存远程地址时会请求访问权限。

**模型推荐**（OpenCode Go，官方额度数据见 [opencode.ai/docs/go](https://opencode.ai/docs/go/)）：

| 模型 | 5 小时额度请求数 | 适用 |
|---|---|---|
| `deepseek-v4-flash` | 7,600 | 日常翻译首选 |
| `glm-5.3-flash` | 1,580 | 质量略高 |
| `mimo-v2.5` | 30,100 | 大批量翻译 |

### 请求头合规说明

OpenCode Go 官方要求第三方工具：不产生滥用流量、正确自我标识、携带 `x-opencode-session` 请求头（2026-09-06 起强制，用于 prompt caching 优化）。本扩展已实现（见 `background/service-worker.js` 的 `apiHeaders()`）：

- `Authorization: Bearer <key>` — 认证
- `x-opencode-session: <uuid>` — 每个页面翻译会话生成一个稳定 UUID
- `x-opencode-client: pure-translate/1.0` — 工具自我标识

API 直连 `https://opencode.ai/zen/go/v1/chat/completions`，Key 仅存于浏览器本地 `chrome.storage.local`，不经过任何第三方服务器。

## 使用

- **翻译当前页**：点扩展图标 →「翻译当前页面」，或按 `Alt+T`，或右键菜单「翻译整个页面」
- **还原**：再次点击 / 快捷键，或右键菜单「还原页面」
- **双语 / 单语切换**：popup 中切换；已翻译页面切换会自动重渲染（命中缓存，不耗额度）
- **划词翻译**：选中文字 → 右键「翻译选中文字」

## 设置项

- **API**：Key、Base URL（默认 OpenCode Go 官方端点，可换任意 OpenAI 兼容端点）、模型
- **翻译**：默认模式、目标语言（10 种）、每批段落数、并发请求数
- **思考强度**：关闭（默认，最快）/ 低 / 高；模型不支持时自动剥离参数重试
- **角色**：自动识别 / 手动指定 / 附加翻译要求（如「术语 foo 保留原文」）
- **排除**：URL 黑名单（支持 `*` 通配）、自定义 CSS 选择器排除

## 实现参考

实现前调研了以下开源同类项目的源码（仅借鉴思路，未复制代码）：

- **ReadFrog 陪读蛙**（[mengxi-ream/read-frog](https://github.com/mengxi-ream/read-frog)，GPL-3.0）：视口门控、批量超时随字符数伸缩、缓存 TTL 策略、`batchDOMOperation` rAF 渲染合帧、单语模式对齐失败的整段替换兜底、`%%` 批量分隔协议思路（本扩展采用编号协议 + 宽松回退替代）
- **kiss-translator**（[fishjar/kiss-translator](https://github.com/fishjar/kiss-translator)，GPL-3.0）：`getComputedStyle` WeakMap 缓存、并发池 + 重试设计、`innerText` 换 `textContent` 规避强制重排
- **TWP**（[FilipePS/Traduzir-paginas-web](https://github.com/FilipePS/Traduzir-paginas-web)，MPL-2.0）：相同请求共享 Promise 去重思路
- **Linguist / domtranslator**（[translate-tools](https://github.com/translate-tools/domtranslator)，Apache-2.0）：防死循环的自变更标记思路

## 项目结构

```
pure-translate/
├── manifest.json            # MV3 清单（host: opencode.ai + localhost 任意端口）
├── background/
│   └── service-worker.js    # 多供应商 LLM 调用、请求头、重试、缓存、右键菜单
├── content/
│   ├── content.js           # 段落提取、智能跳过、双语/单语渲染、视口调度、MutationObserver
│   └── content.css
├── lib/
│   ├── prompts.js           # 站点角色提示词、批次协议、输出解析器、缓存 key
│   └── provider.js          # 供应商抽象（OpenCode Go / LM Studio / 自定义）
├── popup/                   # 快速控制面板
├── options/                 # 设置页
├── icons/                   # 扩展图标
└── test/                    # node --test test/*.test.mjs
```

## 验证

```bash
node --test test/prompts.test.mjs   # 13 项单测全部通过
node --check content/content.js     # 语法检查通过
```

## 更新插件（开发迭代）

改完代码后**不要移除扩展**（移除会清空 key 和全部设置）：

1. `chrome://extensions/` → 纯译卡片上点 **⟳ 重新加载**——代码更新，key/设置/缓存全保留
2. 改动 `content/` 目录下的文件时，已打开的网页需要刷新一次（旧 content script 仍挂在页面内存里）
3. 改 popup / options / service-worker 时 ⟳ 即生效

设置页的「导出配置 / 导入配置」用于真正的重装场景（换机器、误移除）：导出 JSON 含 API Key，请妥善保管。

## 已知限制

- 翻译 PDF / YouTube 字幕 / 输入框不在范围内（刻意裁剪）
- 复杂 Web 应用（如在线编辑器）可能有个别段落误翻，可用 CSS 选择器排除
- 模型输出的占位符若与原文结构不匹配，该段自动降级为双语或保留原文，不会破坏页面
- 插入译文会使下方内容下移（未做视口位置补偿）
