import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../background.js", import.meta.url), "utf8");

function loadBackground({ settings, fetchImpl }) {
  const listeners = {};
  const context = {
    console,
    TextDecoder,
    URL,
    setTimeout,
    clearTimeout,
    AbortController,
    btoa,
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: {
          get: async () => ({ ...settings }),
          set: async () => {}
        }
      },
      runtime: {
        onInstalled: { addListener: (fn) => { listeners.onInstalled = fn; } },
        onMessage: { addListener: (fn) => { listeners.onMessage = fn; } },
        openOptionsPage: async () => {}
      },
      action: {
        onClicked: { addListener: (fn) => { listeners.onClicked = fn; } }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "background.js" });
  return context;
}

function baseSettings(overrides = {}) {
  return {
    provider: "chat",
    apiKey: "sk-test",
    model: "gpt-5.5",
    apiBase: "https://sub2api.hitu.me",
    api2dBase: "https://oa.api2d.net/v1",
    defaultLanguage: "zh",
    defaultStyle: "sharp",
    maxChineseChars: 100,
    maxEnglishWords: 49,
    bannedWords: "",
    projectHandle: "",
    customPrompt: "",
    debugMode: false,
    ...overrides
  };
}

function providerSettings(provider, profileOverrides = {}, overrides = {}) {
  const defaults = {
    openai_chat:      { apiKey: "sk-chat",      model: "gpt-4.1-mini",      apiBase: "https://api.openai.com/v1" },
    openai_responses: { apiKey: "sk-resp",      model: "gpt-4.1-mini",      apiBase: "https://api.openai.com/v1" },
    gemini:           { apiKey: "AIzaSyTEST",   model: "gemini-2.0-flash",  apiBase: "https://generativelanguage.googleapis.com/v1beta" },
    anthropic:        { apiKey: "sk-ant-test",  model: "claude-sonnet-4-5", apiBase: "https://api.anthropic.com" },
    newapi:           { apiKey: "sk-newapi",    model: "gpt-4.1-mini",      apiBase: "https://newapi.hitu.me/v1" },
    sub2api:          { apiKey: "sk-sub",       model: "gpt-4.1-mini",      apiBase: "https://demo.sub2api.org/v1" },
    api2d:            { apiKey: "fk-test",      model: "gpt-4o-mini",       apiBase: "https://oa.api2d.net/v1" }
  };
  const profile = { ...defaults[provider], ...profileOverrides };
  return baseSettings({
    provider,
    apiKey: profile.apiKey,
    model: profile.model,
    apiBase: profile.apiBase,
    providerProfiles: {
      [provider]: profile
    },
    ...overrides
  });
}

function payload(overrides = {}) {
  return {
    tweetText: "AI 工具最大的价值不是替代人，而是把普通人的试错成本压低。",
    author: "Tester",
    authorHandle: "@tester",
    mentionedHandles: [],
    url: "https://x.com/tester/status/1",
    language: "zh",
    ...overrides
  };
}

test("Chat Completions 200 HTML response is treated as configuration error, not fallback text", async () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => "<!doctype html><html><title>sub2api</title></html>",
      json: async () => { throw new Error("not json"); }
    })
  });

  await assert.rejects(
    () => context.generateReply(payload()),
    /返回的不是 JSON|Base URL|chat\/completions/
  );
});

test("generateReplies returns three cleaned candidates from a JSON array response", async () => {
  const context = loadBackground({
    settings: baseSettings({
      customPrompt: "更像真实评论区，短、狠、准；不要标题。"
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              "真正省下来的不是时间，是少走弯路的成本。",
              "很多人怕被替代，其实先被替代的是低质量重复。",
              "工具没变聪明，聪明的是会用工具的人。"
            ])
          }
        }]
      })
    })
  });

  assert.equal(typeof context.generateReplies, "function");
  const replies = Array.from(await context.generateReplies(payload(), 3), String);
  assert.deepEqual(replies, [
    "真正省下来的不是时间，是少走弯路的成本",
    "很多人怕被替代，其实先被替代的是低质量重复",
    "工具没变聪明，聪明的是会用工具的人"
  ]);
});

function recordingFetch(responseBody, contentType = "application/json") {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => contentType },
      text: async () => typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody)
    };
  };
  return { calls, fetchImpl };
}

test("anthropic provider posts to /v1/messages with x-api-key header and parses content[].text", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{
      type: "text",
      text: JSON.stringify([
        "项目不是讲故事，是把交付节奏跑出来",
        "市场只奖励能持续上线的团队，废话再多也没用",
        "比起愿景，先把这个月能跑通的环节稳住"
      ])
    }]
  });

  const context = loadBackground({
    settings: providerSettings("anthropic"),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-ant-test");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(replies.length, 3);
});

test("gemini provider posts to /models/{model}:generateContent with x-goog-api-key header", async () => {
  const { calls, fetchImpl } = recordingFetch({
    candidates: [{
      content: {
        parts: [{
          text: JSON.stringify([
            "技术债不还，迟早还利息",
            "讨论永远比执行轻松，所以大多数人留在讨论里",
            "速度本身就是优势，慢就是另一种放弃"
          ])
        }]
      }
    }]
  });

  const context = loadBackground({
    settings: providerSettings("gemini"),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
  assert.equal(calls[0].init.headers["x-goog-api-key"], "AIzaSyTEST");
  assert.ok(!("Authorization" in calls[0].init.headers), "gemini 不应携带 Authorization");
  assert.equal(replies.length, 3);
});

test("newapi provider routes through OpenAI chat completions endpoint", async () => {
  const { calls, fetchImpl } = recordingFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          "上线之前再多预判，都不如真实流量教做人",
          "团队的差距就在收到反馈到改完的那个小时里",
          "做不出复购的功能，不是产品问题，是没人愿意为它停下来"
        ])
      }
    }]
  });

  const context = loadBackground({
    settings: providerSettings("newapi"),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://newapi.hitu.me/v1/chat/completions");
  assert.match(calls[0].init.headers.Authorization, /^Bearer sk-newapi$/);
  assert.equal(replies.length, 3);
});

test("legacy provider id 'chat' is migrated to 'openai_chat' at request time", async () => {
  const { calls, fetchImpl } = recordingFetch({
    choices: [{
      message: {
        content: JSON.stringify([
          "升级要悄悄的，用户感觉不到才算成功",
          "数据迁移最怕的是写了一半没人复核",
          "向后兼容写错一个字段，新老两版都会出事"
        ])
      }
    }]
  });

  // 老用户：顶层 provider="chat" + 顶层 apiKey/model/apiBase，没有 providerProfiles
  const context = loadBackground({
    settings: baseSettings({
      provider: "chat",
      apiKey: "sk-legacy",
      apiBase: "https://api.openai.com/v1",
      model: "gpt-4.1-mini"
    }),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  assert.match(calls[0].init.headers.Authorization, /^Bearer sk-legacy$/);
  assert.equal(replies.length, 3);
});

// v2.1.3 — Base URL 自动补全归一化：用户填啥粒度都能拼对
test("v2.1.3: anthropic 用户填根域名（不带 /v1）时，fetch URL 仍是 /v1/messages", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("anthropic", { apiBase: "https://api.deepseek.com/anthropic" }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
});

test("v2.1.3: anthropic 用户填带 /v1 时，fetch URL 不会重复 v1", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("anthropic", { apiBase: "https://api.deepseek.com/anthropic/v1" }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://api.deepseek.com/anthropic/v1/messages");
});

test("v2.1.3: openai_chat 用户填根域名时，fetch URL 自动补 /v1/chat/completions", async () => {
  const { calls, fetchImpl } = recordingFetch({
    choices: [{ message: { content: JSON.stringify(["A", "B", "C"]) } }]
  });

  const context = loadBackground({
    settings: providerSettings("openai_chat", { apiBase: "https://api.deepseek.com" }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
});

test("v2.1.3: # 终止符强制透传，绕过任何自动补全", async () => {
  const { calls, fetchImpl } = recordingFetch({
    choices: [{ message: { content: JSON.stringify(["A", "B", "C"]) } }]
  });

  const context = loadBackground({
    settings: providerSettings("openai_chat", {
      apiBase: "https://my.proxy/azure/openai/deployments/X/chat/completions#"
    }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(calls[0].url, "https://my.proxy/azure/openai/deployments/X/chat/completions");
});

test("v2.1.3: gemini 用户填根域名时，fetch URL 自动补 /v1beta/models/{model}:generateContent", async () => {
  const { calls, fetchImpl } = recordingFetch({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(["A", "B", "C"]) }] }
    }]
  });

  const context = loadBackground({
    settings: providerSettings("gemini", { apiBase: "https://generativelanguage.googleapis.com" }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
});

// v2.2.1 — 推理模型的思考过程与正文共用输出额度，额度被思考吃光时正文为 0。
// 这类失败必须报清原因，不能笼统说“模型没有返回可用回复内容”。
test("v2.2.1: anthropic 只返回 thinking 块且被 max_tokens 截断时，报思考占满额度", async () => {
  const { calls, fetchImpl } = recordingFetch({
    type: "message",
    role: "assistant",
    model: "deepseek-flash",
    content: [{ type: "thinking", thinking: "用户要英文回复，三条角度不同……", signature: "sig" }],
    stop_reason: "max_tokens",
    usage: { output_tokens: 450, output_tokens_details: { thinking_tokens: 450 } }
  });

  const context = loadBackground({
    settings: providerSettings("anthropic", { model: "deepseek-flash" }),
    fetchImpl
  });

  await assert.rejects(
    () => context.generateReplies(payload(), 3),
    (error) => {
      assert.match(error.message, /思考/);
      assert.match(error.message, /thinking_tokens 450/);
      assert.match(error.message, /max_tokens/);
      return true;
    }
  );
  assert.equal(calls.length, 2, "先原样请求一次，再关掉思考重试一次；不进入三轮候选重试");
  assert.equal(JSON.parse(calls[0].init.body).thinking, undefined, "首次请求不干预端点默认行为");
  assert.equal(JSON.parse(calls[1].init.body).thinking.type, "disabled", "重试时显式关闭思考");
});

test("v2.2.1: 关掉思考重试后拿到正文即返回，不再报错", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = calls.length === 1
      ? {
          content: [{ type: "thinking", thinking: "想了很久……", signature: "sig" }],
          stop_reason: "max_tokens",
          usage: { output_tokens: 1600, output_tokens_details: { thinking_tokens: 1600 } }
        }
      : {
          content: [{ type: "text", text: JSON.stringify(["门槛是别人看不见的成本", "容易是结果，不是过程", "先看清水位再谈努力"]) }]
        };
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(body)
    };
  };

  const context = loadBackground({
    settings: providerSettings("anthropic", { model: "deepseek-flash" }),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(calls.length, 2);
  assert.equal(replies.length, 3);
  assert.equal(replies[0], "门槛是别人看不见的成本");
});

test("v2.2.1: 3 条候选的 max_tokens 提到 1600 以上，给推理模型留思考预算", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("anthropic"),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);

  const body = JSON.parse(calls[0].init.body);
  assert.ok(body.max_tokens >= 1600, `max_tokens 应 ≥ 1600，实际 ${body.max_tokens}`);
});

test("v2.2.1: Chat Completions 正文为空但带 reasoning_content 时给出明确提示", async () => {
  const { fetchImpl } = recordingFetch({
    choices: [{ message: { content: "", reasoning_content: "先想清楚推文在讲什么……" } }]
  });

  const context = loadBackground({
    settings: providerSettings("openai_chat"),
    fetchImpl
  });

  await assert.rejects(
    () => context.generateReplies(payload(), 3),
    /reasoning_content|推理内容/
  );
});

test("v2.2.1: Responses 渠道 output 只有 reasoning 项时给出明确提示", async () => {
  const { fetchImpl } = recordingFetch({
    output: [{ type: "reasoning", summary: [] }],
    status: "incomplete"
  });

  const context = loadBackground({
    settings: providerSettings("openai_responses"),
    fetchImpl
  });

  await assert.rejects(
    () => context.generateReplies(payload(), 3),
    /推理项|reasoning/
  );
});

// v2.2.1 — 后台请求原先没有超时，接口不返回时按钮会一直停在“生成中”。
test("v2.2.1: 接口在超时时间内没有响应时中断请求并给出可读提示", async () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      // 模拟接口挂住：只有超时中断才会 reject
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });

  await assert.rejects(
    () => context.fetchWithTimeout("https://api.example.com/v1/chat/completions", {}, 60),
    /秒内没有响应/
  );
});

test("v2.2.1: 正常返回时 fetchWithTimeout 不会改动响应", async () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] })
    })
  });

  const response = await context.fetchWithTimeout("https://api.example.com/v1/chat/completions", {});
  const data = JSON.parse(await response.text());
  assert.equal(data.choices[0].message.content, "ok");
});
test("v2.2.1: 没有 AbortController 的环境退化为普通请求而不抛错", async () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });
  delete context.AbortController;
  const response = await context.fetchWithTimeout("https://api.example.com/v1/chat/completions", {});
  assert.equal(response.status, 200);
});

// v2.2.1 — 模型输出撞上 max_tokens 时 JSON 不完整，旧逻辑把整段残片当一条候选，
// 首尾还留着 `["` 这类包装字符。
test("v2.2.1: 截断的 JSON 只取完整闭合的字符串项，不把残片整段当候选", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const truncated = `["第一条完整候选", "第二条还没写完`;
  const parsed = Array.from(context.parseReplyCandidates(truncated), String);
  assert.deepEqual(parsed, ["第一条完整候选"]);
});

test("v2.2.1: 候选首尾的 JSON 包装字符会被清掉，正常方括号正文不受影响", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const settings = { maxChineseChars: 24, maxEnglishWords: 22, bannedWords: "", defaultLanguage: "en" };
  const payload = { language: "en", style: "sharp" };

  const wrapped = context.cleanReply(`["Everyone measures difficulty fast ["`, settings, payload);
  assert.ok(!wrapped.includes("["), `不应残留方括号：${wrapped}`);
  assert.ok(wrapped.startsWith("Everyone"), `应以正文开头：${wrapped}`);

  const bracketBody = context.cleanReply("[Update] 我们今天上线了新版本", { ...settings, defaultLanguage: "zh" }, { language: "zh" });
  assert.equal(bracketBody, "[Update] 我们今天上线了新版本");
});

// v2.2.2 — 推文图片理解：content 只给 URL，后台下载转 base64，按渠道拼多模态入参。
function visionFetch({ apiBody, rejectVision = false }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("pbs.twimg.com")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/jpeg" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
      };
    }
    const bodyText = typeof init?.body === "string" ? init.body : "";
    if (rejectVision && bodyText.includes("image")) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: { message: "this model does not support image input" } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(apiBody)
    };
  };
  return { calls, fetchImpl };
}

function visionPayload() {
  return payload({
    photos: [{ url: "https://pbs.twimg.com/media/abc123?format=jpg&name=small", alt: "一张 K 线图" }]
  });
}

const visionReplies = {
  content: [{ type: "text", text: JSON.stringify(["图里那根针是假的", "别只看 K 线，看量", "这波是洗盘不是崩"]) }]
};

test("v2.2.2: anthropic 带图时把图片作为 base64 image 块放在正文之前", async () => {
  const { calls, fetchImpl } = visionFetch({ apiBody: visionReplies });
  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });

  await context.generateReplies(visionPayload(), 3);

  const apiCall = calls.find((call) => !call.url.includes("pbs.twimg.com"));
  const body = JSON.parse(apiCall.init.body);
  const content = body.messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.type, "base64");
  assert.equal(content[0].source.media_type, "image/jpeg");
  assert.equal(content[content.length - 1].type, "text");
});

test("v2.2.2: openai chat 带图时 user content 变成 text + image_url 数组", async () => {
  const apiBody = { choices: [{ message: { content: JSON.stringify(["A", "B", "C"]) } }] };
  const { calls, fetchImpl } = visionFetch({ apiBody });
  const context = loadBackground({ settings: providerSettings("openai_chat"), fetchImpl });

  await context.generateReplies(visionPayload(), 3);

  const apiCall = calls.find((call) => !call.url.includes("pbs.twimg.com"));
  const content = JSON.parse(apiCall.init.body).messages[1].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image_url");
  assert.match(content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test("v2.2.2: gemini 带图时 parts 里出现 inline_data", async () => {
  const apiBody = { candidates: [{ content: { parts: [{ text: JSON.stringify(["A", "B", "C"]) }] } }] };
  const { calls, fetchImpl } = visionFetch({ apiBody });
  const context = loadBackground({ settings: providerSettings("gemini"), fetchImpl });

  await context.generateReplies(visionPayload(), 3);

  const apiCall = calls.find((call) => !call.url.includes("pbs.twimg.com"));
  const parts = JSON.parse(apiCall.init.body).contents[0].parts;
  assert.ok(parts[0].text);
  assert.equal(parts[1].inline_data.mime_type, "image/jpeg");
  assert.equal(typeof parts[1].inline_data.data, "string");
});

test("v2.2.2: 渠道拒绝图片入参时自动退回纯文本重试", async () => {
  const { calls, fetchImpl } = visionFetch({ apiBody: visionReplies, rejectVision: true });
  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });

  const replies = await context.generateReplies(visionPayload(), 3);

  assert.equal(replies.length, 3);
  const apiCalls = calls.filter((call) => !call.url.includes("pbs.twimg.com"));
  assert.equal(apiCalls.length, 2, "先带图失败，再纯文本重试");
  assert.match(apiCalls[0].init.body, /image/);
  assert.doesNotMatch(apiCalls[1].init.body, /"type":"image"/);
});

test("v2.2.2: 关闭图片理解后不发图片请求", async () => {
  const { calls, fetchImpl } = visionFetch({ apiBody: visionReplies });
  const context = loadBackground({
    settings: providerSettings("anthropic", {}, { visionEnabled: false }),
    fetchImpl
  });

  await context.generateReplies(visionPayload(), 3);

  assert.equal(calls.filter((call) => call.url.includes("pbs.twimg.com")).length, 0);
  const apiCall = calls.find((call) => !call.url.includes("pbs.twimg.com"));
  assert.equal(typeof JSON.parse(apiCall.init.body).messages[0].content, "string");
});

test("v2.2.2: 按设置截断图片数量，多出的不下载", async () => {
  const photos = [1, 2, 3, 4].map((i) => ({
    url: `https://pbs.twimg.com/media/p${i}?format=jpg&name=small`,
    alt: ""
  }));
  const { calls, fetchImpl } = visionFetch({ apiBody: visionReplies });
  const context = loadBackground({
    settings: providerSettings("anthropic", {}, { maxPhotos: 2 }),
    fetchImpl
  });

  await context.generateReplies(payload({ photos }), 3);

  assert.equal(calls.filter((call) => call.url.includes("pbs.twimg.com")).length, 2);
  const body = JSON.parse(calls.find((call) => !call.url.includes("pbs.twimg.com")).init.body);
  assert.equal(body.messages[0].content.filter((block) => block.type === "image").length, 2);
});

// v2.2.5 — 生成被 max_tokens 截断时，英文候选会停在虚词上，整条丢弃。
test("v2.2.5: 末尾是虚词的长英文候选被判为截断并丢弃", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const truncated = "Thoreau was measuring what he'd already chosen to give up, not what he was forced to";
  const complete = "Real cost isn't the sticker, it's the payment plan, and the bill shows up later with interest";

  assert.equal(context.looksTruncatedEnglish(truncated), true);
  assert.equal(context.looksTruncatedEnglish(complete), false);
});

test("v2.2.5: 短句自然以虚词收尾时不误杀", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  assert.equal(context.looksTruncatedEnglish("I think so"), false);
  assert.equal(context.looksTruncatedEnglish("That is what it is"), false);
});

test("v2.2.5: 英文场景下截断候选不进入最终结果", async () => {
  const context = loadBackground({
    settings: baseSettings({
      defaultLanguage: "en",
      maxEnglishWords: 120,
      bannedWords: ""
    }),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              "Thoreau was measuring what he had already chosen to give up, not what he was forced to",
              "Real cost is not the sticker, it is the payment plan and the interest that shows up later",
              "Cheap entry is the trap because the carrying cost arrives in small amounts over years"
            ])
          }
        }]
      })
    })
  });

  const replies = Array.from(
    await context.generateReplies(payload({ language: "en" }), 3),
    String
  );

  assert.ok(!replies.some((r) => /forced to$/.test(r)), `截断候选应被丢弃：${JSON.stringify(replies)}`);
});

// v2.3.0 — 从 "Crypto KOL 专用" 改为通用回复插件：按原推领域自适应，不硬套行业视角。
// v2.5.0 — 提示词大幅精简：规则从 22 条降到 8 条，只保留硬约束。
// 起因是同样的推文，DeepSeek 网页版用一句自然请求就写出了四条短而像人话的回复，
// 插件却在 22 条规则里挣扎，输出全是论述体。
test("v2.5.0: 提示词只保留硬约束，不再堆砌规则", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const instructions = context.buildInstructions(
    { ...baseSettings(), customPrompt: "" },
    { language: "zh", style: "sharp" },
    3
  );

  assert.match(instructions, /你在帮用户回复一条 X 推文/);
  assert.match(instructions, /原推英文就回英文，中文就回中文/);
  assert.match(instructions, /口语，短句，像真人随手打的/);
  assert.match(instructions, /不要写成小作文/);
  assert.match(instructions, /不要编造原文没有的东西/);
  assert.match(instructions, /图片用来看懂语境，不要描述画面里的人物长相、表情/);
  assert.match(instructions, /输出 JSON 数组，3 条/);

  // 旧的重规则全部移除
  assert.doesNotMatch(instructions, /三条的分工：/);
  assert.doesNotMatch(instructions, /信息边界：/);
  assert.doesNotMatch(instructions, /有观点，有棱角/);
  assert.doesNotMatch(instructions, /不改原文的褒贬/);
  assert.doesNotMatch(instructions, /原文举了哪个例子就顺着说/);

  // 篇幅：精简后的提示词应明显短于旧版（旧版约 1480 字符）
  assert.ok(instructions.length < 700, `提示词应精简到 700 字符内，实际 ${instructions.length}`);
});

test("v2.5.0: 语言与长度按参数动态生成", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const en = context.buildInstructions(
    { ...baseSettings(), maxEnglishWords: 44, customPrompt: "" },
    { language: "en", style: "sharp" },
    3
  );
  assert.match(en, /每条 44 个英文单词左右/);
  assert.match(en, /输出 JSON 数组，3 条/);

  const zh = context.buildInstructions(
    { ...baseSettings(), maxChineseChars: 38, customPrompt: "" },
    { language: "zh", style: "sharp" },
    3
  );
  assert.match(zh, /每条 38 个中文字符左右/);
});

test("v2.5.0: 禁用词为空时不输出空行", () => {
  const context = loadBackground({
    settings: baseSettings({ bannedWords: "" }),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const instructions = context.buildInstructions(
    { ...baseSettings(), bannedWords: "", customPrompt: "" },
    { language: "zh", style: "sharp" },
    3
  );
  assert.doesNotMatch(instructions, /禁用词：\s*$/m);
});

test("v2.3.2: 开启自动翻译时把候选翻成中文", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["最难的是一直在变", "凌晨两点读到", "塞内卡说得轻巧"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("anthropic"),
    fetchImpl
  });

  const translations = Array.from(await context.translateReplies(["A", "B", "C"]), String);
  assert.equal(translations.length, 3);
  assert.equal(translations[0], "最难的是一直在变");
  assert.match(calls[0].init.body, /翻译/);
});

test("v2.3.2: 关闭自动翻译时不发任何请求", async () => {
  const { calls, fetchImpl } = recordingFetch({ content: [{ type: "text", text: "[]" }] });

  const context = loadBackground({
    settings: providerSettings("anthropic", {}, { autoTranslate: false }),
    fetchImpl
  });

  const translations = Array.from(await context.translateReplies(["A", "B"]), String);
  assert.deepEqual(translations, []);
  assert.equal(calls.length, 0);
});

test("v2.3.2: 没有 API Key 时翻译直接返回空，不抛错", async () => {
  const { calls, fetchImpl } = recordingFetch({ content: [{ type: "text", text: "[]" }] });

  const context = loadBackground({
    settings: baseSettings({ apiKey: "", providerProfiles: {} }),
    fetchImpl
  });

  const translations = Array.from(await context.translateReplies(["A"]), String);
  assert.deepEqual(translations, []);
  assert.equal(calls.length, 0);
});

// v2.3.12 — 图片文字提取：独立一次视觉请求，结果给草稿窗展示。
test("v2.3.12: describePhotos 读出图片里的文字", async () => {
  const { calls, fetchImpl } = visionFetch({
    apiBody: { content: [{ type: "text", text: "Do what you know is right for you and your family" }] }
  });

  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });
  const text = await context.describePhotos([
    { url: "https://pbs.twimg.com/media/quote1?format=jpg&name=small", alt: "" }
  ]);

  assert.match(text, /Do what you know is right/);
  const apiCall = calls.find((call) => !call.url.includes("pbs.twimg.com"));
  assert.match(apiCall.init.body, /读取图片里的文字|读出这些图片里的文字/);
});

test("v2.3.12: 关闭图片理解时不做文字提取", async () => {
  const { calls, fetchImpl } = visionFetch({ apiBody: { content: [{ type: "text", text: "x" }] } });

  const context = loadBackground({
    settings: providerSettings("anthropic", {}, { visionEnabled: false }),
    fetchImpl
  });

  const text = await context.describePhotos([
    { url: "https://pbs.twimg.com/media/quote1?format=jpg&name=small", alt: "" }
  ]);

  assert.equal(text, "");
  assert.equal(calls.length, 0);
});

test("v2.3.12: 没有图片时直接返回空，不发请求", async () => {
  const { calls, fetchImpl } = visionFetch({ apiBody: { content: [{ type: "text", text: "x" }] } });
  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });

  assert.equal(await context.describePhotos([]), "");
  assert.equal(calls.length, 0);
});

// v2.3.13 — 用户改中文译文后，按新意思重写英文候选。
test("v2.3.13: rewriteReply 把中文改写成英文", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: "Honestly fine with it. Guinea pigs hate being alone." }]
  });

  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });
  const text = await context.rewriteReply("说实话我觉得还行，豚鼠明显讨厌独处");

  assert.match(text, /Honestly fine with it/);
  assert.match(calls[0].init.body, /改写成自然英文/);
});

test("v2.3.13: 译文为空时不发请求", async () => {
  const { calls, fetchImpl } = recordingFetch({ content: [{ type: "text", text: "x" }] });
  const context = loadBackground({ settings: providerSettings("anthropic"), fetchImpl });

  assert.equal(await context.rewriteReply("   "), "");
  assert.equal(calls.length, 0);
});

// v2.3.14 — 线程语境：回复某条评论时，把主帖与上一条评论一并交给模型理解。
test("v2.3.14: buildInput 拼上主帖与上一条评论", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const input = context.buildInput({ projectHandle: "" }, {
    tweetText: "It is foolish to try to be brave in an area where you are not good at.",
    author: "BeiLan",
    authorHandle: "@jiu72295",
    mentionedHandles: [],
    url: "https://x.com/x/status/1",
    threadRoot: "I know that I know nothing.",
    threadPrev: "Socrates really said it best in Apology."
  }, 3, 0);

  assert.match(input, /线程语境（只用来理解这句话在讨论什么，不要直接回复它们）/);
  assert.match(input, /\[主帖\] I know that I know nothing\./);
  assert.match(input, /\[上一条\] Socrates really said it best in Apology\./);
});

test("v2.3.14: 没有线程语境时不出现该段", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const input = context.buildInput({ projectHandle: "" }, {
    tweetText: "hello", author: "x", authorHandle: "@x", mentionedHandles: [], url: "u"
  }, 3, 0);

  assert.doesNotMatch(input, /线程语境/);
});

test("v2.3.14: 上一条与主帖内容相同时不重复输出", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const input = context.buildInput({ projectHandle: "" }, {
    tweetText: "reply", author: "x", authorHandle: "@x", mentionedHandles: [], url: "u",
    threadRoot: "same text", threadPrev: "same text"
  }, 3, 0);

  assert.equal((input.match(/same text/g) || []).length, 1);
});

// v2.6.0 — 中文推文也可以优先给英文回复，由 forceEnglishReplies 控制。
// 三处语言判定（提示词、长度截断、残句过滤）必须一致。
test("v2.6.0: 开关开启时中文推文也走英文规则", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const on = context.buildInstructions(
    { ...baseSettings(), forceEnglishReplies: true, maxEnglishWords: 44, customPrompt: "" },
    { language: "zh", style: "sharp" },
    3
  );
  assert.match(on, /一律用自然英文回复，原推是中文也一样/);
  assert.match(on, /每条 44 个英文单词左右/);

  const off = context.buildInstructions(
    { ...baseSettings(), forceEnglishReplies: false, maxChineseChars: 38, customPrompt: "" },
    { language: "zh", style: "sharp" },
    3
  );
  assert.match(off, /原推英文就回英文，中文就回中文/);
  assert.match(off, /每条 38 个中文字符左右/);
});

test("v2.6.0: shouldReplyInEnglish 覆盖四种输入", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  const base = { defaultStyle: "sharp", defaultLanguage: "zh" };

  // 开关开 → 中文推文也判英文
  assert.equal(context.shouldReplyInEnglish({ ...base, forceEnglishReplies: true }, { language: "zh" }), true);
  // 开关关 + 中文推文 → 中文
  assert.equal(context.shouldReplyInEnglish({ ...base, forceEnglishReplies: false }, { language: "zh" }), false);
  // 英文推文 → 永远英文
  assert.equal(context.shouldReplyInEnglish({ ...base, forceEnglishReplies: false }, { language: "en" }), true);
  // 默认语言设成英文 → 全部英文
  assert.equal(context.shouldReplyInEnglish({ ...base, forceEnglishReplies: false, defaultLanguage: "en" }, { language: "zh" }), true);
});

// v2.6.1 — 非 /v1 前缀的网关（如火山引擎 /api/v3）也要正确补全。
test("v2.6.1: 自定义版本段 /api/v3 只拼端点尾，不重复加 /v1", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  assert.equal(
    context.buildFinalEndpoint("openai_responses", "https://ark.cn-beijing.volces.com/api/v3", "m"),
    "https://ark.cn-beijing.volces.com/api/v3/responses"
  );
  assert.equal(
    context.buildFinalEndpoint("openai_responses", "https://ark.cn-beijing.volces.com/api/v3/responses", "m"),
    "https://ark.cn-beijing.volces.com/api/v3/responses"
  );
});

test("v2.6.1: 放宽后原有行为不变", () => {
  const context = loadBackground({
    settings: baseSettings(),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" })
  });

  assert.equal(
    context.buildFinalEndpoint("openai_chat", "https://api.openai.com", "m"),
    "https://api.openai.com/v1/chat/completions"
  );
  assert.equal(
    context.buildFinalEndpoint("anthropic", "https://api.deepseek.com/anthropic", "m"),
    "https://api.deepseek.com/anthropic/v1/messages"
  );
  assert.equal(
    context.buildFinalEndpoint("gemini", "https://generativelanguage.googleapis.com", "gemini-2.0-flash"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
  );
});

// v2.6.2 — Response 渠道按需关闭模型思考以提速；网关不认该参数时自动回退。
test("v2.6.2: 开启关闭思考时请求体带 reasoning.effort=none", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("openai_responses", {}, { disableReasoning: true }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.reasoning, { effort: "none" });
});

test("v2.6.2: 关闭该开关时不带 reasoning 字段", async () => {
  const { calls, fetchImpl } = recordingFetch({
    content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }]
  });

  const context = loadBackground({
    settings: providerSettings("openai_responses", {}, { disableReasoning: false }),
    fetchImpl
  });

  await context.generateReplies(payload(), 3);
  assert.equal(JSON.parse(calls[0].init.body).reasoning, undefined);
});

test("v2.6.2: 网关不认 reasoning 参数时去掉重试", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    if (body.reasoning) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning'" } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ content: [{ type: "text", text: JSON.stringify(["A", "B", "C"]) }] })
    };
  };

  const context = loadBackground({
    settings: providerSettings("openai_responses", {}, { disableReasoning: true }),
    fetchImpl
  });

  const replies = await context.generateReplies(payload(), 3);
  assert.equal(replies.length, 3);
  assert.equal(calls.length, 2, "先带 reasoning 失败，再去掉重试");
  assert.equal(JSON.parse(calls[1].init.body).reasoning, undefined);
});
