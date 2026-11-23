const PROVIDER_IDS = [
  "openai_chat",
  "openai_responses",
  "gemini",
  "anthropic",
  "newapi",
  "sub2api",
  "api2d",
  "custom"
];

const PROVIDER_DEFAULTS = {
  openai_chat:      { apiKey: "", model: "gpt-4.1-mini",       apiBase: "https://api.openai.com/v1" },
  openai_responses: { apiKey: "", model: "gpt-4.1-mini",       apiBase: "https://api.openai.com/v1" },
  gemini:           { apiKey: "", model: "gemini-2.0-flash",   apiBase: "https://generativelanguage.googleapis.com/v1beta" },
  anthropic:        { apiKey: "", model: "claude-sonnet-4-5",  apiBase: "https://api.anthropic.com" },
  newapi:           { apiKey: "", model: "gpt-4.1-mini",       apiBase: "" },
  sub2api:          { apiKey: "", model: "gpt-4.1-mini",       apiBase: "" },
  api2d:            { apiKey: "", model: "gpt-4o-mini",        apiBase: "https://oa.api2d.net/v1" },
  custom:           { apiKey: "", model: "", apiBase: "", customProtocol: "openai_chat" }
};

function emptyProviderProfiles() {
  const out = {};
  for (const id of PROVIDER_IDS) out[id] = { ...PROVIDER_DEFAULTS[id] };
  return out;
}

const DEFAULT_SETTINGS = {
  provider: "openai_responses",
  apiKey: "",
  model: "gpt-4.1-mini",
  apiBase: "https://api.openai.com/v1",
  api2dBase: "https://oa.api2d.net/v1",
  providerProfiles: emptyProviderProfiles(),
  defaultLanguage: "zh",
  defaultStyle: "sharp",
  forceEnglishReplies: true,
  disableReasoning: true,
  maxChineseChars: 24,
  maxEnglishWords: 22,
  visionEnabled: true,
  maxPhotos: 3,
  autoTranslate: true,
  bannedWords: "我觉得,值得关注,持续看好,赋能,生态,未来可期,多维度,深度解析,感谢分享,确实如此,听起来,看起来,哇,真不错,想试试,太猛了,兄弟们,不仅,更是",
  projectHandle: "",
  customPrompt: "",
  debugMode: false
};

const STYLE_MAP = {
  sharp: "默认风格：短、有判断，像真人随手回复，不端着，不油腻"
};

function log(...args) {
  if (globalThis.__AKIII_DEBUG__) console.log("[X Reply]", ...args);
}

// 请求超时。没有超时控制时，接口不返回会让按钮一直停在“生成中”，
// STATE.activeRequest 也不会释放，用户只能刷新页面才能再点。
const REQUEST_TIMEOUT_MS = 60000;

async function fetchWithTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  // 极老的环境没有 AbortController，退化为普通请求，至少不直接抛错。
  if (typeof AbortController !== "function") return fetch(url, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`接口 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请求已中断。请检查 Base URL、网络与渠道是否可用。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBase(base, fallback) {
  const raw = String(base || fallback || "").trim().replace(/\/+$/, "");
  return raw || fallback;
}

// 8 个 provider 走的真实 endpoint —— 与 options.js 的 buildEndpointPreview 一一对应。
// v2.1.3 起支持自动补全：根域名 / /v1 / /v1/ / 完整 endpoint / 末尾 # 透传 都能正确归一化。
// 改这里前先看 docs/开发及迭代方案调研报告/2026-05-19-v2.1.3-Base-URL-自动补全归一化.md
const PROVIDER_PATH_SPEC = {
  openai_chat:      { versionSeg: "/v1",     endpointTail: "/chat/completions" },
  openai_responses: { versionSeg: "/v1",     endpointTail: "/responses" },
  newapi:           { versionSeg: "/v1",     endpointTail: "/chat/completions" },
  sub2api:          { versionSeg: "/v1",     endpointTail: "/chat/completions" },
  api2d:            { versionSeg: "/v1",     endpointTail: "/chat/completions" },
  anthropic:        { versionSeg: "/v1",     endpointTail: "/messages" },
  gemini:           { versionSeg: "/v1beta", endpointTail: "/models/{model}:generateContent" }
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFinalEndpoint(provider, base, model) {
  const raw = String(base || "").trim();
  if (!raw) return "";

  // 1. # 终止符：用户显式声明完整 URL，仅去掉末尾 # 和 /
  if (raw.endsWith("#")) {
    return raw.slice(0, -1).replace(/\/+$/, "");
  }

  // 2. 去掉末尾 0+ 个 /
  const trimmed = raw.replace(/\/+$/, "");

  // 3. 未知 provider 兜底为 openai_chat 风格
  const spec = PROVIDER_PATH_SPEC[provider] || PROVIDER_PATH_SPEC.openai_chat;

  // 4. 用户已填完整 endpoint：识别并透传。
  // 只看是否以端点尾结尾，不要求版本段一定是 /v1——火山引擎用的是 /api/v3/responses，
  // 各家中转网关也常见 /api/v2、/openai/v1 这类前缀。
  if (provider === "gemini") {
    if (/\/models\/[^/]+:generateContent$/i.test(trimmed)) return trimmed;
  } else {
    const tail = spec.endpointTail.toLowerCase();
    if (trimmed.toLowerCase().endsWith(tail)) return trimmed;
  }

  // 5. 已含版本段就不再补：/v1 精确匹配（不误判 /v1beta），
  // 或者形如 /api/v3、/v2beta 的自定义版本段也算。
  const versionEndRe = new RegExp(escapeRegex(spec.versionSeg) + "$", "i");
  const customVersionRe = /\/(?:api\/)?v\d+(?:beta)?$/i;
  const baseWithVersion = versionEndRe.test(trimmed) || customVersionRe.test(trimmed)
    ? trimmed
    : trimmed + spec.versionSeg;

  // 6. 拼 endpointTail（gemini 替换 {model} 占位）
  let tail = spec.endpointTail;
  if (provider === "gemini") {
    const modelLabel = String(model || "").trim() || "gemini-2.0-flash";
    tail = tail.replace("{model}", encodeURIComponent(modelLabel));
  }
  return baseWithVersion + tail;
}

// 老用户的 provider id 迁移：v2.0 的 "chat" → v2.1 的 "openai_chat"。
// 同时把老顶层 apiKey/model/apiBase/api2dBase 同步到 providerProfiles，
// 避免用户已配置的接口在升级后变空。
function migrateSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, ...raw };

  if (settings.provider === "chat") settings.provider = "openai_chat";
  if (!PROVIDER_IDS.includes(settings.provider)) settings.provider = "openai_responses";

  const profiles = { ...emptyProviderProfiles(), ...(settings.providerProfiles || {}) };
  for (const id of PROVIDER_IDS) {
    profiles[id] = { ...PROVIDER_DEFAULTS[id], ...(profiles[id] || {}) };
  }

  const current = settings.provider;
  const currentProfile = profiles[current];
  // 顶层字段优先权高于 profile —— 用户上一版填的就是顶层这套
  if (settings.apiKey && !currentProfile.apiKey) currentProfile.apiKey = settings.apiKey;
  if (settings.model && currentProfile.model === PROVIDER_DEFAULTS[current].model) currentProfile.model = settings.model;
  if (settings.apiBase && currentProfile.apiBase === PROVIDER_DEFAULTS[current].apiBase) currentProfile.apiBase = settings.apiBase;

  // 老 api2dBase 字段优先回填到 api2d profile
  if (settings.api2dBase && !profiles.api2d.apiBase) profiles.api2d.apiBase = settings.api2dBase;

  settings.providerProfiles = profiles;
  return settings;
}

function getEffectiveProvider(settings) {
  const key = String(settings.apiKey || "").trim();
  // API2D 的 Forward Key 通常是 fk 开头。用户如果误选 OpenAI 官方接口，
  // OpenAI 会直接返回 Incorrect API key。这里自动切到 API2D，减少小白配置成本。
  // 注意：sub2api / newapi 的 Key 也是 sk- 开头，不会被这条规则误识别。
  if (/^fk/i.test(key)) return "api2d";
  return settings.provider || DEFAULT_SETTINGS.provider;
}

function getActiveProfile(settings) {
  const provider = getEffectiveProvider(settings);
  const profile = (settings.providerProfiles || {})[provider] || {};
  const defaults = PROVIDER_DEFAULTS[provider] || {};
  return {
    provider,
    apiKey: profile.apiKey || settings.apiKey || "",
    model: profile.model || settings.model || defaults.model || "",
    apiBase: profile.apiBase || settings.apiBase || defaults.apiBase || "",
    customProtocol: profile.customProtocol || defaults.customProtocol || "openai_chat"
  };
}

function explainApiError(errorMessage, settings) {
  const msg = String(errorMessage || "");
  const key = String(settings.apiKey || "").trim();
  const effective = getEffectiveProvider(settings);

  if (/incorrect api key|invalid api key|401|unauthorized/i.test(msg)) {
    if (/^fk/i.test(key)) {
      return "你填的是 fk 开头的 Key，像 API2D/中转 Key。请在插件里选择 API2D / Chat Completions，或使用官方 OpenAI 的 sk- / sk-proj- Key。";
    }
    if (effective === "openai_responses" && !/^sk-/i.test(key)) {
      return "当前选择的是 OpenAI 官方接口，但这个 Key 不像官方 OpenAI Key。官方 Key 通常以 sk- 或 sk-proj- 开头。";
    }
    if (effective === "anthropic") {
      return "Anthropic 接口认证失败。请确认填的是 Anthropic Key（或 DeepSeek 等兼容入口的 sk- Key），并检查 Base URL。";
    }
    if (effective === "gemini") {
      return "Gemini 接口认证失败。请确认填的是 Google AI Studio 的 API Key，并检查 Base URL 是否到 /v1beta 这一级。";
    }
    return "API Key 不正确或已失效。请重新复制完整 Key，确认没有空格，并保存后刷新 X 页面。";
  }

  return msg || "接口请求失败";
}

async function getSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const settings = migrateSettings(saved);
  globalThis.__AKIII_DEBUG__ = Boolean(settings.debugMode);
  return settings;
}

function parseList(text) {
  return String(text || "")
    .split(/[，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function getSmallestRepeatedSegment(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const compact = s.replace(/\s+/g, '');
  if (compact.length < 6) return null;

  for (let unitLen = 2; unitLen <= Math.floor(compact.length / 2); unitLen++) {
    if (compact.length % unitLen !== 0) continue;
    const unit = compact.slice(0, unitLen);
    const repeatCount = compact.length / unitLen;
    if (repeatCount < 2) continue;
    if (unit.repeat(repeatCount) !== compact) continue;

    let seen = '';
    for (let i = 0; i < s.length; i++) {
      if (!/\s/.test(s[i])) seen += s[i];
      if (seen === unit) return s.slice(0, i + 1).trim();
    }
    return unit;
  }
  return null;
}

function dedupeRepeatedText(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return s;

  // 连续压缩多次，处理“同一句复制 2/3/4 遍”的情况。
  for (let round = 0; round < 5; round++) {
    const before = s;
    const smallest = getSmallestRepeatedSegment(s);
    if (smallest && smallest.length < s.length) s = smallest;

    for (let i = Math.floor(s.length / 2) - 3; i <= Math.floor(s.length / 2) + 3; i++) {
      if (i <= 0 || i >= s.length) continue;
      const a = s.slice(0, i).trim();
      const b = s.slice(i).trim();
      if (a && a === b) {
        s = a;
        break;
      }
    }

    const parts = s.split(/(?<=[。！？!?；;])\s*|\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const out = [];
      for (const part of parts) {
        const bare = part.replace(/[。.!！?？；;]+$/g, '').trim();
        const last = out.length ? out[out.length - 1].replace(/[。.!！?？；;]+$/g, '').trim() : '';
        if (bare && bare !== last) out.push(part);
      }
      s = out.join(' ').trim();
    }

    if (s === before) break;
  }

  return s;
}

function maybeRepairMojibake(text) {
  const raw = String(text || "");
  if (!raw) return raw;
  const chineseCount = (raw.match(/[一-鿿]/g) || []).length;
  const weirdCount = (raw.match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ�]/g) || []).length;
  const looksBroken = weirdCount >= 3 && chineseCount === 0;
  if (!looksBroken) return raw;

  const candidates = [];
  try {
    const bytes = Uint8Array.from(Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff));
    candidates.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (_) {}

  try {
    // 处理常见的 UTF-8 被当 Latin-1 读出的情况，如 ä¸­æ–‡
    candidates.push(decodeURIComponent(escape(raw)));
  } catch (_) {}

  for (const candidate of candidates) {
    const cChinese = (candidate.match(/[一-鿿]/g) || []).length;
    const cBroken = (candidate.match(/�/g) || []).length;
    if (cChinese > chineseCount && cBroken === 0) return candidate;
  }
  return raw;
}

function looksLikeBrokenText(text) {
  const s = String(text || "");
  if (!s.trim()) return true;
  if ((s.match(/�/g) || []).length > 0) return true;
  const suspicious = (s.match(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) || []).length;
  const chinese = (s.match(/[一-鿿]/g) || []).length;
  return suspicious >= 4 && chinese === 0;
}

// 生成撞上 max_tokens 时，英文候选会停在一句话中间，末尾往往是虚词：
// “...not what he was forced to”“...and”“...of the”。这类残句整条丢弃，
// 宁可少一条也要让用户拿到能直接发的完整句子。
const TRUNCATED_ENGLISH_TAIL = /\b(and|or|but|to|of|in|on|with|that|which|the|a|an|is|was|are|were|for|as|at|by|if|so|than|then|when|while|not)$/i;

function looksTruncatedEnglish(reply) {
  const words = String(reply || "").trim().split(/\s+/).filter(Boolean);
  // 短句常自然地以虚词收尾（“I think so”“That is what it is”），只在 8 词以上判定。
  if (words.length < 8) return false;
  const tail = words[words.length - 1].replace(/[.,;:!?"'”’]+$/, "");
  return TRUNCATED_ENGLISH_TAIL.test(tail);
}

// 回复语言判定。中文推文是否也给英文，由 forceEnglishReplies 控制；
// 三处（提示词、长度截断、残句过滤）必须用同一套判断，否则会出现
// 「按英文写、按中文截」这种错位。
function shouldReplyInEnglish(settings, payload) {
  const styleId = payload.style || settings.defaultStyle || "sharp";
  return Boolean(
    payload.language === "en"
    || styleId === "english"
    || settings.defaultLanguage === "en"
    || settings.forceEnglishReplies
  );
}

function clampReplyCount(count) {
  const n = Number(count || 1);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.round(n), 1), 5);
}

// 推文图片理解：内容脚本只给出图片 URL，下载与 base64 编码在后台完成。
// 单张上限 5MB，超过直接跳过——原图常见几 MB，小规格（name=small）通常 50-150KB。
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_FETCH_TIMEOUT_MS = 15000;

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function loadPhotos(rawPhotos, limit) {
  const list = Array.isArray(rawPhotos) ? rawPhotos : [];
  const max = Math.min(Math.max(Number(limit) || 0, 0), 4);
  if (!max || !list.length) return [];

  const photos = [];
  for (const item of list) {
    if (photos.length >= max) break;
    const url = String(item?.url || "").trim();
    if (!/^https:\/\//i.test(url)) continue;
    try {
      const response = await fetchWithTimeout(url, {}, PHOTO_FETCH_TIMEOUT_MS);
      if (!response.ok) {
        log("photo skipped by status", response.status, url);
        continue;
      }
      const buffer = await response.arrayBuffer();
      if (!buffer?.byteLength || buffer.byteLength > MAX_PHOTO_BYTES) {
        log("photo skipped by size", buffer?.byteLength, url);
        continue;
      }
      const mime = String(response.headers?.get?.("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!/^image\//.test(mime)) {
        log("photo skipped by type", mime, url);
        continue;
      }
      photos.push({ base64: bytesToBase64(new Uint8Array(buffer)), mime, alt: String(item?.alt || "").trim() });
    } catch (error) {
      log("photo fetch failed", url, error?.message);
    }
  }
  return photos;
}

function buildInstructions(settings, payload, replyCount = 1) {
  const mergedBanned = unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)]).join("、") || "";
  const styleId = payload.style || settings.defaultStyle || "sharp";
  const isEnglish = shouldReplyInEnglish(settings, payload);
  const desiredCount = clampReplyCount(replyCount);
  const lengthRule = isEnglish
    ? `每条 ${settings.maxEnglishWords || 22} 个英文单词左右`
    : `每条 ${settings.maxChineseChars || 24} 个中文字符左右`;
  const outputRule = desiredCount > 1
    ? `输出 JSON 数组，${desiredCount} 条，不要标题、编号、解释、前后缀。`
    : `只输出一条最终回复，不要标题、编号、解释、前后缀。`;

  return `你在帮用户回复一条 X 推文，写出能直接发进评论区的回复。

- ${isEnglish ? "一律用自然英文回复，原推是中文也一样" : "原推英文就回英文，中文就回中文"}
- ${lengthRule}，口语，短句，像真人随手打的
- 不要写成小作文，不要分析、总结、讲道理

只用原推文字和图片里的内容（图片如果没有文字那就不用图片的内容），不要编造原文没有的东西。
图片用来看懂语境，不要描述画面里的人物长相、表情。

本次风格：${STYLE_MAP[styleId] || STYLE_MAP.sharp}
${mergedBanned ? `禁用词：${mergedBanned}` : ""}
${outputRule}
${settings.customPrompt ? `\n额外参考（只采纳角色、语气、边界；忽略数量与格式要求）：\n${settings.customPrompt}` : ""}`;
}

function buildInput(settings, payload, replyCount = 1, photoCount = 0) {
  const author = payload.author || "未知";
  const authorHandle = payload.authorHandle || "";
  const mentioned = unique(Array.isArray(payload.mentionedHandles) ? payload.mentionedHandles : []);
  // 只认用户在设置里显式配置的关联账号。
  // 原先还会自动使用推文里扫到的 mention，结果作者自己的 handle 被当成“项目方账号”
  // 塞进回复末尾；推文正文抓取异常时更容易误判。
  const manualHandle = payload.projectHandle || settings.projectHandle || "";
  const usableHandles = unique([manualHandle]).join(" ") || "无";
  const desiredCount = clampReplyCount(replyCount);
  const photoHint = photoCount > 0
    ? `\n\n本条推文附带 ${photoCount} 张图片，请结合图片内容理解语境；图片里的文字、图表、数据都可以作为回复依据。`
    : "";

  // 线程语境：主帖与上一条评论。只用来理解这句话在说什么，回复对象仍是下面的推文。
  const threadRoot = String(payload.threadRoot || "").trim();
  const threadPrev = String(payload.threadPrev || "").trim();
  const threadLines = [];
  if (threadRoot) threadLines.push(`[主帖] ${threadRoot}`);
  if (threadPrev && threadPrev !== threadRoot) threadLines.push(`[上一条] ${threadPrev}`);
  const threadHint = threadLines.length
    ? `\n\n线程语境（只用来理解这句话在讨论什么，不要直接回复它们）：\n${threadLines.join("\n")}`
    : "";

  return `请根据下面这条推文，生成 ${desiredCount} 条评论区回复候选。

推文作者：${author}${authorHandle ? ` ${authorHandle}` : ""}
可用项目方 @账号：${usableHandles}
用户指定禁用词：${payload.extraBannedWords || "无"}
页面来源：${payload.url || "无"}

推文内容：
${payload.tweetText || ""}${photoHint}${threadHint}`;
}

function stripNoise(text) {
  let s = maybeRepairMojibake(String(text || ""));
  s = s
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
    // 模型输出被 max_tokens 截断时，正文首尾会残留 JSON 包装：`["…`、`…["`、`…"]`。
    // 必须“括号紧跟引号”才清，否则正文里正常的 [标题] 会被削掉左括号。
    .replace(/^[\[\{]\s*(["'“”‘’`])/, "")
    .replace(/[\[\{]\s*(["'“”‘’`])\s*$/, "")
    .replace(/(["'“”‘’`])\s*[\]\}]\s*$/, "")
    .replace(/^#+\s*(热门评论回复|最适合置顶的.*|最容易引发争议的.*)\s*$/gim, "")
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, "")
    .replace(/^(回复|评论|答案|输出|Reply|Comment|Answer)\s*[:：]\s*/i, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const cutMarkers = ["中文：", "翻译：", "Translation:", "Chinese:", "中文翻译", "解释："];
  for (const marker of cutMarkers) {
    const idx = s.indexOf(marker);
    if (idx > 0) s = s.slice(0, idx).trim();
  }

  return s;
}

function textFromContentValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.content === "string") return value.content;
  return "";
}

function extractModelText(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.reply === "string") return data.reply;
  if (typeof data.response === "string") return data.response;
  if (typeof data.result === "string") return data.result;
  if (typeof data.text === "string") return data.text;

  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  if (choice) {
    const messageText = textFromContentValue(choice.message?.content);
    if (messageText) return messageText;
    const deltaText = textFromContentValue(choice.delta?.content);
    if (deltaText) return deltaText;
    if (typeof choice.text === "string") return choice.text;
  }

  // Anthropic Messages API
  if (Array.isArray(data.content)) {
    const anthropicText = data.content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    if (anthropicText) return anthropicText;
  }

  // Gemini generateContent
  if (Array.isArray(data.candidates) && data.candidates.length) {
    const parts = data.candidates[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const geminiText = parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("");
      if (geminiText) return geminiText;
    }
  }

  const parts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      else if (typeof content.text === "string") parts.push(content.text);
      else if (typeof content.content === "string") parts.push(content.content);
    }
  }
  return parts.join("\n").trim();
}

// 判断响应是否把输出额度全花在思考上（只有 thinking 块，没有正文）。
// DeepSeek 等 Anthropic 兼容端点的思考模式默认打开，思维链与正文共用 max_tokens，
// 会出现“给多少 token 就想到多少 token、正文始终为 0”的情况。
function isThinkingExhausted(data) {
  if (!Array.isArray(data?.content)) return false;
  const blocks = data.content.filter(Boolean);
  const hasText = blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim());
  const hasThinking = blocks.some((block) => block.type === "thinking");
  return !hasText && hasThinking;
}

// 响应结构合法但取不到正文时，把原因说清楚。
// v2.2.1 起因：deepseek-flash 走 anthropic 兼容渠道，thinking 与 text 共用 max_tokens，
// 额度被思考过程占满后 content 里只有 thinking 块，正文 0 token，
// 用户侧只看到“模型没有返回可用回复内容”，分不清是额度不够还是结构不兼容。
function describeNoTextResponse(data) {
  const d = data && typeof data === "object" ? data : {};

  // Anthropic Messages：content[] 里只有 thinking 块
  if (Array.isArray(d.content)) {
    const blocks = d.content.filter(Boolean);
    const hasText = blocks.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim());
    const thinkingTokens = Number(d.usage?.output_tokens_details?.thinking_tokens) || 0;
    if (!hasText && blocks.some((block) => block.type === "thinking")) {
      if (d.stop_reason === "max_tokens") {
        return `模型把输出额度全部用在思考上（thinking_tokens ${thinkingTokens}），正文 0 token 即被 max_tokens 截断。该端点未接受关闭思考的请求，请换用非推理模型，或改用输出上限更高的渠道。`;
      }
      return "模型只返回了思考过程，没有返回正文。请换用非推理模型。";
    }
  }

  // OpenAI Responses：output[] 里只有 reasoning 项，没有 message 项
  if (Array.isArray(d.output) && d.output.length) {
    const types = unique(d.output.map((item) => item?.type).filter(Boolean));
    if (types.length && !types.includes("message")) {
      return `模型输出里只有推理项（${types.join("、")}），没有正文消息。请换用非推理模型。`;
    }
  }

  // Chat Completions：正文为空，但带了 reasoning_content
  const choice = Array.isArray(d.choices) ? d.choices[0] : null;
  if (choice?.message && typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content.trim()) {
    return "模型只返回了推理内容（reasoning_content），正文为空。请换用非推理模型。";
  }

  const keys = Object.keys(d).slice(0, 10).join("、") || "无";
  return `响应里没有找到正文。响应顶层字段：${keys}。`;
}

function requireModelText(data) {
  const text = extractModelText(data);
  if (text) return text;
  throw new Error(describeNoTextResponse(data));
}

function previewText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function readJsonResponse(response, requestUrl, settings) {
  const contentType = String(response.headers?.get?.("content-type") || "");
  const bodyText = await response.text().catch(() => "");
  let data = {};

  if (bodyText.trim()) {
    try {
      data = JSON.parse(bodyText);
    } catch (_) {
      const looksHtml = /text\/html/i.test(contentType) || /^\s*</.test(bodyText);
      const hint = looksHtml
        ? "接口返回的是 HTML 页面，不是 OpenAI 兼容 JSON。Base URL 可能填成了网站首页/控制台地址，或接口路径不对。"
        : "接口返回的不是 JSON，插件无法解析模型正文。";
      const preview = previewText(bodyText);
      throw new Error(`${hint} 当前请求地址：${requestUrl}${preview ? `；返回预览：${preview}` : ""}`);
    }
  }

  if (!response.ok) {
    throw new Error(explainApiError(data?.error?.message || data?.message || `${requestUrl} 请求失败：${response.status}`, settings));
  }

  return data;
}

function parsedCandidatesFromValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.reply === "string") return item.reply;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    for (const key of ["replies", "candidates", "items", "outputs"]) {
      const found = parsedCandidatesFromValue(value[key]);
      if (found.length) return found;
    }
  }
  return [];
}

// 从被截断的 JSON 里捞出完整闭合的字符串项。
// 输出撞上 max_tokens 时 JSON 结构不完整，JSON.parse 必然失败，但往往已经写完了
// 一到两条完整字符串；不捞的话整段残片会被当成一条候选，既超长又带包装字符。
function extractQuotedStrings(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const value = match[1]
      .replace(/\\n/g, " ")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim();
    if (value) out.push(value);
  }
  return out;
}

function tryParseReplyJson(raw) {
  const text = String(raw || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const candidates = [text];
  const arrStart = text.indexOf("[");
  const arrEnd = text.lastIndexOf("]");
  if (arrStart >= 0 && arrEnd > arrStart) candidates.push(text.slice(arrStart, arrEnd + 1));
  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) candidates.push(text.slice(objStart, objEnd + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const replies = parsedCandidatesFromValue(parsed);
      if (replies.length) return replies;
    } catch (_) {}
  }

  // JSON 不完整时的兜底：整体仍像数组/对象开头，就只取完整闭合的字符串项，
  // 丢掉被截断的尾巴，避免整段残片变成一条超长候选。
  if (/^\s*[\[\{]/.test(text)) {
    const quoted = extractQuotedStrings(text);
    if (quoted.length) return quoted;
  }
  return [];
}

function splitReplyText(raw) {
  const text = String(raw || "")
    .replace(/^```[\w-]*\s*/i, "")
    .replace(/```\s*$/i, "")
    .replace(/\r/g, "")
    .trim();
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const items = [];

  for (const line of lines) {
    if (/^#+\s*/.test(line)) continue;
    if (/^(以下是|Here are|输出|回复候选)/i.test(line)) continue;
    const match = line.match(/^(?:[-*•]\s*|\d+\s*[\.\)、)]\s*)(.+)$/);
    if (match?.[1]) items.push(match[1].trim());
  }

  if (items.length) return items;
  return lines.length > 1 ? lines : (text ? [text] : []);
}

function parseReplyCandidates(raw) {
  return tryParseReplyJson(raw).length ? tryParseReplyJson(raw) : splitReplyText(raw);
}

function cleanReplyCandidates(candidates, settings, payload, count) {
  const replies = [];
  const seen = new Set();
  const isEnglish = shouldReplyInEnglish(settings, payload);
  for (const candidate of candidates) {
    const reply = cleanReply(candidate, settings, payload);
    const key = normalizeTextForCompare(reply);
    if (!reply || !key || seen.has(key)) continue;
    if (hasBannedWord(reply, settings, payload) || looksLikeBrokenText(reply)) continue;
    if (isEnglish && looksTruncatedEnglish(reply)) continue;
    seen.add(key);
    replies.push(reply);
    if (replies.length >= count) break;
  }
  return replies;
}

function normalizeTextForCompare(text) {
  return String(text || "").replace(/\s+/g, "").replace(/[。.!！?？；;]+$/g, "").trim();
}

function cleanReply(text, settings, payload) {
  let reply = dedupeRepeatedText(stripNoise(text));
  const isEnglish = shouldReplyInEnglish(settings, payload);

  if (isEnglish) {
    const words = reply.split(/\s+/).filter(Boolean);
    const limit = Math.max(Number(settings.maxEnglishWords || 22) + 8, 14);
    if (words.length > limit) reply = words.slice(0, limit).join(" ");
  } else {
    const max = Math.max(Number(settings.maxChineseChars || 24) + 18, 30);
    if (Array.from(reply).length > max) {
      const firstClause = reply.split(/[。！？!?；;\n]/).map((s) => s.trim()).find(Boolean);
      reply = firstClause && Array.from(firstClause).length <= max ? firstClause : Array.from(reply).slice(0, max).join("");
    }
  }

  reply = dedupeRepeatedText(reply);
  reply = reply.replace(/[。.]$/g, "").trim();
  return reply;
}

function hasBannedWord(reply, settings, payload) {
  const words = unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)]);
  return words.some((word) => word && reply.includes(word));
}

function removeBannedWords(reply, settings, payload) {
  let s = reply;
  for (const word of unique([...parseList(settings.bannedWords), ...parseList(payload.extraBannedWords)])) {
    if (!word) continue;
    s = s.split(word).join("");
  }
  return s.replace(/\s{2,}/g, " ").trim();
}

function tokenLimitForCount(count) {
  const desired = clampReplyCount(count);
  // v2.2.1：推理模型的思考过程与正文共用输出额度。旧值 3 条只有 450 token，
  // deepseek-flash 实测思考就吃掉 450，正文 0 token 就被 max_tokens 截断，
  // content 里只剩 thinking 块，用户只看到“模型没有返回可用回复内容”。
  // max_tokens 是上限而非固定消耗，调高对普通模型不增加实际用量。
  return desired > 1 ? Math.max(1600, desired * 500) : 800;
}

// 各协议的多模态入参格式互不相同，集中在下面四个小函数里，request* 只负责拼装。
function chatContentWithPhotos(input, photos) {
  if (!photos.length) return input;
  return [
    { type: "text", text: input },
    ...photos.map((photo) => ({ type: "image_url", image_url: { url: `data:${photo.mime};base64,${photo.base64}` } }))
  ];
}

function responsesInputWithPhotos(input, photos) {
  if (!photos.length) return input;
  return [{
    role: "user",
    content: [
      { type: "input_text", text: input },
      ...photos.map((photo) => ({ type: "input_image", image_url: `data:${photo.mime};base64,${photo.base64}` }))
    ]
  }];
}

function geminiPartsWithPhotos(input, photos) {
  return [
    { text: input },
    ...photos.map((photo) => ({ inline_data: { mime_type: photo.mime, data: photo.base64 } }))
  ];
}

function anthropicContentWithPhotos(input, photos) {
  if (!photos.length) return input;
  return [
    ...photos.map((photo) => ({ type: "image", source: { type: "base64", media_type: photo.mime, data: photo.base64 } })),
    { type: "text", text: input }
  ];
}

async function requestOpenAIChat(profile, instructions, input, replyCount, settings, requestUrl, photos = []) {
  const response = await fetchWithTimeout(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Authorization": `Bearer ${profile.apiKey}`
    },
    body: JSON.stringify({
      model: profile.model || DEFAULT_SETTINGS.model,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: chatContentWithPhotos(input, photos) }
      ],
      temperature: 0.85,
      max_tokens: tokenLimitForCount(replyCount)
    })
  });

  const data = await readJsonResponse(response, requestUrl, settings);
  return requireModelText(data);
}

async function requestOpenAIResponses(profile, instructions, input, replyCount, settings, requestUrl, photos = []) {
  const buildBody = (withReasoningOff) => {
    const body = {
      model: profile.model || DEFAULT_SETTINGS.model,
      instructions,
      input: responsesInputWithPhotos(input, photos),
      temperature: 0.85,
      max_output_tokens: tokenLimitForCount(replyCount)
    };
    // 推理模型的思考过程与正文共用额度，且会明显拖慢响应。
    // 这里按需关闭；部分网关不认 reasoning 字段，失败后自动去掉重试。
    if (withReasoningOff) body.reasoning = { effort: "none" };
    return body;
  };

  const send = async (withReasoningOff) => {
    const response = await fetchWithTimeout(requestUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Bearer ${profile.apiKey}`
      },
      body: JSON.stringify(buildBody(withReasoningOff))
    });
    return readJsonResponse(response, requestUrl, settings);
  };

  if (!settings.disableReasoning) {
    return requireModelText(await send(false));
  }

  try {
    return requireModelText(await send(true));
  } catch (error) {
    const message = String(error?.message || "");
    // 只有「不认这个参数」才回退；Key 错、地址错这类重试也没用。
    if (!/reasoning|unsupported|unrecognized|unknown|invalid|extra/i.test(message)) throw error;
    log("gateway rejected reasoning: none, retrying without it", message);
    return requireModelText(await send(false));
  }
}

async function requestGemini(profile, instructions, input, replyCount, settings, requestUrl, photos = []) {
  const response = await fetchWithTimeout(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "x-goog-api-key": profile.apiKey
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: instructions }] },
      contents: [{ role: "user", parts: geminiPartsWithPhotos(input, photos) }],
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: tokenLimitForCount(replyCount)
      }
    })
  });

  const data = await readJsonResponse(response, requestUrl, settings);
  return requireModelText(data);
}

async function requestAnthropic(profile, instructions, input, replyCount, settings, requestUrl, photos = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "x-api-key": profile.apiKey,
    "anthropic-version": "2023-06-01"
  };
  const requestBody = {
    model: profile.model || PROVIDER_DEFAULTS.anthropic.model,
    max_tokens: tokenLimitForCount(replyCount),
    system: instructions,
    messages: [{ role: "user", content: anthropicContentWithPhotos(input, photos) }],
    temperature: 0.85
  };
  const send = async (body) => {
    const response = await fetchWithTimeout(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    return readJsonResponse(response, requestUrl, settings);
  };

  const data = await send(requestBody);
  if (!isThinkingExhausted(data)) return requireModelText(data);

  // DeepSeek 等 Anthropic 兼容端点的思考模式默认打开，思维链与正文共用 max_tokens，
  // 结果是“给多少额度就想到多少额度、正文恒为 0”。本插件只生成几十个词的短评论，
  // 思考过程没有收益，这里显式关闭后重试一次；端点若不认该字段，报错会退回原提示。
  log("thinking exhausted, retry with thinking disabled", replyCount);
  const retryData = await send({ ...requestBody, thinking: { type: "disabled" } });
  return requireModelText(retryData);
}

async function callModel(settings, instructions, input, replyCount = 1, photos = []) {
  const profile = getActiveProfile(settings);
  const { provider, customProtocol } = profile;

  let requestUrl;
  let actualProtocol;

  if (provider === "custom") {
    // custom 渠道完全透传：用户必须自己填完整 endpoint URL，不参与归一化
    const raw = String(profile.apiBase || "").trim();
    if (!raw) throw new Error("自定义接口需要在设置里填写完整的 endpoint URL");
    requestUrl = raw.endsWith("#")
      ? raw.slice(0, -1).replace(/\/+$/, "")
      : raw.replace(/\/+$/, "");
    actualProtocol = customProtocol || "openai_chat";
  } else {
    // 标准 provider：buildFinalEndpoint 自动补全归一化
    requestUrl = buildFinalEndpoint(provider, profile.apiBase, profile.model)
      || buildFinalEndpoint(provider, PROVIDER_DEFAULTS[provider]?.apiBase || "", profile.model);
    if (!requestUrl) throw new Error(`${provider} 渠道需要在设置里填写 Base URL`);
    actualProtocol = provider;
  }

  const send = (list) => {
    switch (actualProtocol) {
      case "openai_responses":
        return requestOpenAIResponses(profile, instructions, input, replyCount, settings, requestUrl, list);
      case "gemini":
        return requestGemini(profile, instructions, input, replyCount, settings, requestUrl, list);
      case "anthropic":
        return requestAnthropic(profile, instructions, input, replyCount, settings, requestUrl, list);
      case "openai_chat":
      case "newapi":
      case "sub2api":
      case "api2d":
      default:
        return requestOpenAIChat(profile, instructions, input, replyCount, settings, requestUrl, list);
    }
  };

  try {
    return await send(photos);
  } catch (error) {
    // 部分中转站不转发图片入参，带图必失败。此时退回纯文本再试一次，
    // 至少保证有回复可编辑，不让整个生成挂在图片上。
    if (!photos.length) throw error;
    log("vision request failed, retry as text only", error?.message);
    return await send([]);
  }
}

async function generateReplies(payload, replyCount = 3) {
  const settings = await getSettings();
  const profile = getActiveProfile(settings);
  if (!profile.apiKey || !profile.apiKey.trim()) {
    throw new Error("请先点击插件图标，在设置里保存 API Key");
  }
  const desiredCount = clampReplyCount(replyCount);

  const merged = {
    ...payload,
    style: payload.style || "sharp",
    language: payload.language || settings.defaultLanguage
  };

  // 图片下载放在请求前统一做一次，三轮重试复用同一批 base64，避免重复拉取。
  const photos = settings.visionEnabled ? await loadPhotos(merged.photos, settings.maxPhotos) : [];
  log("photos loaded", photos.length);

  const input = buildInput(settings, merged, desiredCount, photos.length);
  let instructions = buildInstructions(settings, merged, desiredCount);
  const collected = [];
  let lastRaw = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await callModel(settings, instructions, input, desiredCount, photos);
    lastRaw = raw;
    collected.push(...parseReplyCandidates(raw));
    const replies = cleanReplyCandidates(collected, settings, merged, desiredCount);
    log("reply attempt", attempt + 1, replies);

    if (replies.length >= desiredCount) {
      return replies;
    }

    instructions += `\n\n上一次输出不合格：只得到 ${replies.length}/${desiredCount} 条可用候选，或存在重复、禁用词、空内容。请重新生成 ${desiredCount} 条全新的候选，只输出 JSON 数组，必须避开禁用词。`;
  }

  const replies = cleanReplyCandidates(collected, settings, merged, desiredCount);
  if (replies.length) return replies;
  const preview = previewText(lastRaw);
  throw new Error(`模型没有返回可用回复内容${preview ? `；返回预览：${preview}` : ""}`);
}

// 用户改完中文译文后，把新意思回写成英文，覆盖原候选。
const REWRITE_INSTRUCTIONS = `把用户给出的中文改写成自然英文，用于 X 评论区回复。
- 只输出英文结果，不要解释、不要引号、不要编号、不要前缀
- 保持口语、简短，像真人随手写的，不要翻译腔
- 长度与中文原文相当，不要明显变长`;

async function rewriteReply(text) {
  const source = String(text || "").trim();
  if (!source) return "";

  const settings = await getSettings();
  const profile = getActiveProfile(settings);
  if (!profile.apiKey || !profile.apiKey.trim()) return "";

  const raw = await callModel(settings, REWRITE_INSTRUCTIONS, source, 1, []);
  return String(raw || "").trim().slice(0, 600);
}

// 读出图片里的文字，供草稿窗展示。独立一次多模态请求，失败返回空字符串，
// 不影响主生成流程。
const PHOTO_TEXT_INSTRUCTIONS = `你在读取图片里的文字。
- 只输出图片中实际出现的文字，原样照抄，不要翻译、不要解释
- 图片里没有文字就输出空字符串
- 不要输出 JSON，不要加引号、编号或前缀`;

async function describePhotos(rawPhotos) {
  const list = Array.isArray(rawPhotos) ? rawPhotos : [];
  if (!list.length) return "";

  const settings = await getSettings();
  if (!settings.visionEnabled) return "";

  const profile = getActiveProfile(settings);
  if (!profile.apiKey || !profile.apiKey.trim()) return "";

  // 最多读 2 张：这一步只为给人看个大概，不是主生成链路
  const photos = await loadPhotos(list, 2);
  if (!photos.length) return "";

  const raw = await callModel(settings, PHOTO_TEXT_INSTRUCTIONS, "读出这些图片里的文字。", 1, photos);
  return String(raw || "").trim().slice(0, 600);
}

async function generateReply(payload) {
  const replies = await generateReplies(payload, 1);
  return replies[0];
}

// 英文候选的中文译文。独立一次轻量请求，失败不影响主流程；
// 中文推文本就不需要，由调用方按候选语言先判一次，这里再做一次开关兜底。
const TRANSLATE_INSTRUCTIONS = `你是翻译引擎。
把用户给出的每一段文本逐条翻译成简体中文，源语言可能是英文、日文、韩文或其他语言。
- 只输出一个 JSON 数组，元素数量与输入完全一致
- 只翻原意，不解释、不扩写、不加编号或前缀
- 保持口语，不要润色成书面语
- 哪一条本身就是中文，就原样返回那一条`;

async function translateReplies(texts) {
  const list = (Array.isArray(texts) ? texts : [])
    .map((text) => String(text || "").trim())
    .filter(Boolean)
    .slice(0, 6);   // 候选最多 5 条 + 原推原文 1 条
  if (!list.length) return [];

  const settings = await getSettings();
  if (!settings.autoTranslate) return [];

  const profile = getActiveProfile(settings);
  if (!profile.apiKey || !profile.apiKey.trim()) return [];

  const raw = await callModel(settings, TRANSLATE_INSTRUCTIONS, JSON.stringify(list), list.length, []);
  return parseReplyCandidates(raw)
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, list.length);
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const migrated = migrateSettings(existing);
  await chrome.storage.local.set(migrated);
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "generateReply") {
    generateReply(message.payload || {})
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "generateReplies") {
    generateReplies(message.payload || {}, message.count || 3)
      .then((replies) => sendResponse({ ok: true, replies }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "rewriteReply") {
    rewriteReply(message.text || "")
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "describePhotos") {
    describePhotos(message.photos || [])
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "translateReplies") {
    translateReplies(message.texts || [])
      .then((translations) => sendResponse({ ok: true, translations }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.action === "getSettings") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings: { ...settings, apiKey: settings.apiKey ? "***" : "" } }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});
