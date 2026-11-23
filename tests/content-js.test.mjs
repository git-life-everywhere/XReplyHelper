import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");

function functionBlock(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const next = source.indexOf("\n  function ", start + 1);
  const nextAsync = source.indexOf("\n  async function ", start + 1);
  const candidates = [next, nextAsync].filter((index) => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function asyncFunctionBlock(name) {
  const start = source.indexOf(`async function ${name}`);
  assert.notEqual(start, -1, `missing async function ${name}`);
  const next = source.indexOf("\n  function ", start + 1);
  const nextAsync = source.indexOf("\n  async function ", start + 1);
  const candidates = [next, nextAsync].filter((index) => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("textbox selection prefers the visible X dialog over page textboxes", () => {
  const block = functionBlock("getBestTextbox");
  const dialogIndex = block.indexOf("const dialogBoxes = getDialogTextboxes();");
  const pageActiveIndex = block.indexOf("!active.closest?.('.akiii-draft-panel')");

  assert.match(source, /function getDialogTextboxes\(\)/);
  assert.match(block, /active\.closest\?\.\('div\[role="dialog"\]'\)/);
  assert.ok(dialogIndex !== -1, "dialog textbox lookup is missing");
  assert.ok(pageActiveIndex !== -1, "page textbox fallback is missing");
  assert.ok(dialogIndex < pageActiveIndex, "dialog textbox should be checked before page fallback");
});

test("insert action targets the dialog textbox and the cached editor when both are visible", () => {
  const targets = asyncFunctionBlock("getInsertTargets");
  const clickHandlerStart = source.indexOf("insertBtn.addEventListener('click'");
  assert.notEqual(clickHandlerStart, -1, "missing insert click handler");
  const clickHandler = source.slice(clickHandlerStart, source.indexOf("      });", clickHandlerStart) + 10);

  assert.match(targets, /const dialogBoxes = getDialogTextboxes\(\);/);
  assert.match(targets, /add\(dialogBoxes\.at\(-1\)\);/);
  assert.match(targets, /add\(preferredEditor\);/);
  assert.match(clickHandler, /const targets = await getInsertTargets\(editor,\s*2500\);/);
  assert.match(clickHandler, /for \(const target of targets\)/);
});

test("composer injection scans X post buttons even when X splits them out of the toolbar", () => {
  const scan = functionBlock("scan");
  const inject = functionBlock("injectComposerButton");

  assert.match(source, /const POST_BUTTON_SELECTOR = /);
  assert.match(scan, /querySelectorAll\(POST_BUTTON_SELECTOR\)\]\.forEach\(injectComposerButton\)/);
  assert.match(inject, /getComposerRoot\(anchor\)/);
  assert.match(inject, /querySelector\?\.\(POST_BUTTON_SELECTOR\)/);
});

test("composer injection also scans inline reply textboxes on status pages", () => {
  const scan = functionBlock("scan");
  const root = functionBlock("getComposerRoot");

  assert.match(source, /const COMPOSER_CONTROL_SELECTOR = /);
  assert.match(source, /function hasComposerTextbox\(root\)/);
  assert.match(source, /function hasComposerControls\(root\)/);
  assert.match(root, /hasComposerTextbox\(node\) && hasComposerControls\(node\)/);
  assert.match(scan, /findVisibleTextboxes\(document\)\.forEach\(injectComposerButton\)/);
});

test("composer injection never appends the fill button into textbox-only fallback roots", () => {
  const root = functionBlock("getComposerRoot");
  const inject = functionBlock("injectComposerButton");

  assert.match(root, /node = isTextboxElement\(anchor\) \? anchor\.parentElement : anchor;/);
  assert.match(inject, /if \(!insertion \|\| insertion\.host\.closest\?\.\(TEXTBOX_SELECTOR\)\) return;/);
  assert.doesNotMatch(inject, /root\.appendChild\(btn\)/);
});

test("composer injection keeps rescanning when X reveals the status composer without adding nodes", () => {
  const scan = functionBlock("scan");
  const init = functionBlock("init");
  const observerStart = source.indexOf("STATE.observer.observe");
  assert.notEqual(observerStart, -1, "missing MutationObserver observe call");
  const observer = source.slice(observerStart, source.indexOf(");", observerStart) + 2);

  assert.match(source, /const INITIAL_SCAN_DELAYS = \[/);
  assert.match(source, /function scheduleFollowupScans\(\)/);
  assert.match(init, /scheduleFollowupScans\(\);/);
  assert.match(scan, /scheduleFollowupScans\(\);/);
  assert.match(observer, /attributes:\s*true/);
  assert.match(observer, /attributeFilter:\s*\[/);
});

test("article injection moves the status detail main tweet button to metadata row", () => {
  const detail = functionBlock("getDetailMainTweetMetaHost");
  const inject = functionBlock("injectArticleButton");

  assert.match(source, /function getCurrentStatusId\(\)/);
  assert.match(detail, /time\[datetime\]/);
  assert.match(detail, /a\[href\*="\/status\/"\]/);
  assert.match(detail, /data-testid="User-Name"/);
  assert.match(detail, /closestArticle\(link\) === article/);
  assert.match(inject, /const detailMetaHost = getDetailMainTweetMetaHost\(article\);/);
  assert.ok(
    inject.indexOf("const detailMetaHost = getDetailMainTweetMetaHost(article);") <
      inject.indexOf("replyButton.closest('[role=\"group\"]')"),
    "detail metadata row should be chosen before the action-group fallback"
  );
  assert.match(inject, /btn\.classList\.toggle\('akiii-detail-meta',\s*!!detailMetaHost\)/);
});

test("article injection keeps the timeline button in the native action group fallback", () => {
  const inject = functionBlock("injectArticleButton");
  const scan = functionBlock("scan");

  assert.match(inject, /replyButton\.closest\('\[role="group"\]'\)/);
  assert.match(inject, /createButton\('AI回',\s*'akiii-article'\)/);
  assert.match(inject, /\.\.\.targetHost\.children/);
  assert.match(inject, /targetHost\.insertBefore\(btn,\s*null\)/);
  assert.match(scan, /querySelectorAll\(ARTICLE_SELECTOR\)\]\.forEach\(injectArticleButton\)/);
});

test("article injection dedupes existing AI回 buttons before adding another one", () => {
  const helper = functionBlock("getArticleButtons");
  const inject = functionBlock("injectArticleButton");

  assert.match(helper, /querySelectorAll\(':scope \.akiii-ai-button\.akiii-article'\)/);
  assert.match(helper, /closestArticle\(button\) === article/);
  assert.match(inject, /const existingButtons = getArticleButtons\(article,\s*targetHost\);/);
  assert.match(inject, /existingButtons\.slice\(1\)\.forEach\(\(button\) => button\.remove\(\)\);/);
  assert.match(inject, /const existing = existingButtons\[0\];/);
});

test("article injection dedupes across X virtual-list cells by status id", () => {
  const helper = functionBlock("getArticleButtons");
  const inject = functionBlock("injectArticleButton");

  assert.match(helper, /const statusId = getStatusIdFromHref\(getStatusUrl\(article\)\);/);
  assert.match(helper, /\[data-testid="cellInnerDiv"\]/);
  assert.match(helper, /const buttonStatusId = button\.dataset\?\.akiiiStatusId \|\| '';/);
  assert.match(helper, /if \(statusId && buttonStatusId && buttonStatusId !== statusId\) return;/);
  assert.match(helper, /cell\.querySelectorAll\('\.akiii-ai-button\.akiii-article'\)/);
  assert.match(inject, /existing\.dataset\.akiiiStatusId = getStatusIdFromHref\(getStatusUrl\(article\)\);/);
  assert.match(inject, /btn\.dataset\.akiiiStatusId = getStatusIdFromHref\(getStatusUrl\(article\)\);/);
});

test("draft panel exposes dialog semantics without changing insert behavior", () => {
  const block = functionBlock("showDraftPanel");

  assert.match(block, /panel\.setAttribute\('role',\s*'dialog'\)/);
  assert.match(block, /panel\.setAttribute\('aria-labelledby'/);
  assert.match(block, /panel\.setAttribute\('aria-describedby'/);
  assert.match(block, /item\.setAttribute\('aria-labelledby',\s*`\$\{panelId\}-candidate-\$\{index \+ 1\}`\)/);
  assert.match(block, /<div class="akiii-draft-text-shell">/);
  assert.match(block, /<span class="akiii-draft-floating-label" id="\$\{panelId\}-candidate-\$\{index \+ 1\}">候选 \$\{index \+ 1\}<\/span>/);
  assert.match(block, /textarea class="akiii-draft-text" aria-label="候选 \$\{index \+ 1\} 回复内容"/);
  assert.match(block, /if \(event\.key === 'Escape'\)/);
  assert.match(block, /const targets = await getInsertTargets\(editor,\s*2500\);/);
});

// v2.2.1 — 发帖框（Add another post）没有原推上下文，注入 AI填入 只会报错，
// 且按钮插入点按回复弹窗布局计算，落到发帖框里会浮在 Post 上方。
test("v2.2.1: 只在回复编辑器注入 AI填入，发帖框不注入", () => {
  const inject = functionBlock("injectComposerButton");
  const guard = functionBlock("isReplyComposer");

  assert.match(source, /function isReplyComposer\(editor\)/);
  // 快速命中：aria-label 含 reply / 回复
  assert.match(guard, /aria-label/);
  assert.match(guard, /reply\|回复/);
  // 主判据：所在弹窗里有没有原推，避免 X 改文案后把回复框误判成发帖框
  assert.match(guard, /closest\?\.\('div\[role="dialog"\]'\)/);
  assert.match(guard, /dialog\.querySelector\(ARTICLE_SELECTOR\)/);
  assert.match(inject, /const box = root\.querySelector\?\.\(TEXTBOX_SELECTOR\) \|\| getBestTextbox\(\);/);
  assert.match(inject, /if \(!isReplyComposer\(box\)\) return;/);
});

// v2.2.1 — Promise.all 会等两边都结束，请求挂住时“没找到回复框”的提示永远出不来。
test("v2.2.1: 等回复框与请求模型并行，编辑器超时立即报错不等请求", () => {
  const run = asyncFunctionBlock("runForArticle");

  assert.doesNotMatch(run, /Promise\.all\(/);
  assert.match(run, /const editorPromise = waitForTextbox\(8500\);/);
  assert.match(run, /const repliesPromise = sendGenerateRepliesRequest\(\{ \.\.\.tweet, style \}, 3\);/);
  assert.match(run, /const editor = await editorPromise;/);
  assert.match(run, /if \(!editor\) \{/);
  assert.match(run, /repliesPromise\.catch\(\(\) => \{\}\);/);
  assert.match(run, /throw new Error\('没找到回复框，先手动点开回复再试'\);/);
});

// v2.2.2 — 图片理解：内容脚本只负责给出图片 URL（统一 small 规格），下载与编码在后台。
test("v2.2.2: 抓取推文图片并带上 alt，统一取 small 规格", () => {
  const photos = functionBlock("extractTweetPhotos");

  assert.match(photos, /img\[src\*="pbs\.twimg\.com\/media"\]/);
  assert.match(photos, /name=small/);
  assert.match(photos, /getAttribute\('alt'\)/);
  assert.match(photos, /photos\.length >= 4/);
});

test("v2.2.2: 推文与弹窗两个抽取入口都带 photos 字段", () => {
  const article = functionBlock("extractTweetFromArticle");
  const dialog = functionBlock("extractTweetFromDialog");

  assert.match(article, /photos: extractTweetPhotos\(article\)/);
  assert.match(dialog, /photos: extractTweetPhotos\(dialog\)/);
});

// v2.2.3 — X 对长推只渲染折叠版，DOM 里没有全文。先展开再读，避免用残句生成。
test("v2.2.3: 两个生成入口都先展开长推再读文本", () => {
  const article = asyncFunctionBlock("runForArticle");
  const composer = asyncFunctionBlock("runForComposer");
  const expand = asyncFunctionBlock("expandLongTweet");
  const find = functionBlock("findShowMore");

  assert.match(source, /data-testid="tweet-text-show-more-link"/);
  assert.match(find, /closest\?\.\('div\[data-testid="tweetText"\]'\)/);
  assert.match(find, /Show more\|显示更多\|展示更多/);
  assert.match(expand, /clickLikeUser\(target\)/);

  const articleExpand = article.indexOf("expandLongTweet(article)");
  const articleExtract = article.indexOf("extractTweetFromArticle(article)");
  assert.ok(articleExpand !== -1 && articleExtract !== -1 && articleExpand < articleExtract, "AI回：必须先展开再读");

  const composerExpand = composer.indexOf("expandLongTweet(");
  const composerExtract = composer.indexOf("extractTweetFromContext(");
  assert.ok(composerExpand !== -1 && composerExtract !== -1 && composerExpand < composerExtract, "AI填入：必须先展开再读");
});

// v2.2.3 — 点开回复弹窗后，弹窗里那份原推也顺手展开（不阻塞生成）。
test("v2.2.3: AI回 打开弹窗后异步展开弹窗内原推，不阻塞生成", () => {
  const article = asyncFunctionBlock("runForArticle");

  assert.match(source, /async function waitForDialog\(timeout = 2500\)/);
  assert.match(article, /waitForDialog\(2500\)\.then\(\(dialog\) => \{/);
  assert.match(article, /if \(dialog\) expandLongTweet\(dialog\);/);
  // 打开弹窗后的展开不能 await，否则会拖慢已经拿到正文的生成流程
  assert.doesNotMatch(article, /await expandLongTweet\(dialog\)/);
});

// v2.3.2 — 英文候选异步补中文译文，中文候选不触发请求。
test("v2.3.2: 只有英文候选才请求译文，且异步填充不阻塞草稿窗", () => {
  const needs = functionBlock("needsTranslation");
  const panel = functionBlock("showDraftPanel");
  const attach = asyncFunctionBlock("attachTranslations");

  assert.match(source, /function isMostlyChinese\(text\)/);
  assert.match(needs, /!isMostlyChinese/);
  assert.match(panel, /attachTranslations\(replies, panel, sourceText\);/);
  assert.match(source, /action: 'translateReplies'/);
  assert.match(attach, /akiii-draft-candidate/);
  assert.match(attach, /akiii-draft-translation/);
});

// v2.3.3 — 翻译对象从“英文”扩到“所有非中文”。日文里的汉字会被 CJK 区间命中，
// 必须靠假名/谚文区间排除，否则日文会被误判成中文而不翻译。
test("v2.3.3: 非中文判断排除日文假名与韩文谚文", () => {
  const block = functionBlock("isMostlyChinese");
  assert.match(block, /\\u3040-\\u30ff/);
  assert.match(block, /\\uac00-\\ud7af/);
  assert.match(block, /u4e00-\\u9fff/);
  assert.match(block, /cjk \/ total > 0\.6/);
});

// v2.3.4 — 非中文原推也翻成中文，显示在头部与候选列表之间。
test("v2.3.4: 非中文原推译文显示在头部下方，中文原推不翻", () => {
  const panel = functionBlock("showDraftPanel");
  const attach = asyncFunctionBlock("attachTranslations");

  assert.match(panel, /class="akiii-draft-source" hidden/);
  assert.match(panel, /data-kind="tweet"/);
  assert.match(panel, /data-kind="image"/);
  assert.match(panel, /showDraftPanel\(initialReplies, editor, sourceText = '', photos = \[\]\)/);
  assert.match(attach, /const wantSource = Boolean\(source\) && !isMostlyChinese\(source\);/);
  assert.match(attach, /\[\.\.\.replies, source\.slice\(0, 1200\)\]/);
  assert.match(attach, /translations\[replies\.length\]/);
  assert.match(attach, /querySelector\('\.akiii-draft-source-line\[data-kind="tweet"\]'\)/);
  assert.match(source, /showDraftPanel\(replies, editor, tweet\.tweetText, tweet\.photos\)/);
});

test("v2.3.5: 原推译文直接写入，不做折叠交互", () => {
  const attach = asyncFunctionBlock("attachTranslations");
  assert.match(attach, /line\.textContent = translated;/);
  assert.doesNotMatch(attach, /akiii-draft-source-expanded/);
});

// v2.3.6 — 按钮会被复用到别的推文（虚拟列表重排），创建时闭包里的 article 会过期。
// 点击时必须按按钮当前所在推文取上下文，否则用 A 推文的内容给 B 推文生成。
test("v2.3.6: AI回 点击时按按钮当前所在推文取上下文，不用过期闭包", () => {
  const inject = functionBlock("injectArticleButton");
  assert.match(inject, /runForArticle\(closestArticle\(btn\) \|\| article, btn\);/);
  assert.doesNotMatch(inject, /runForArticle\(article, btn\);/);
});

test("v2.3.6: AI填入 点击时校验锚点是否还在文档里", () => {
  const inject = functionBlock("injectComposerButton");
  assert.match(inject, /runForComposer\(btn\.isConnected \? btn : anchor, btn\);/);
});

// v2.3.8 — 正文抓不到时 fallback 会把作者名/handle/阅读数当内容，
// 作者 handle 随后被当成“推文里提到的账号”塞进回复。
test("v2.3.8: fallback 过滤作者名、handle、阅读数与时间等元信息", () => {
  const meta = functionBlock("isMetaLine");
  const article = functionBlock("extractTweetFromArticle");

  assert.match(meta, /authorHandle && line\.includes\(authorHandle\)/);
  assert.match(meta, /\[KMB\]/);
  assert.match(article, /\.filter\(\(line\) => !isMetaLine\(line, name, authorHandle\)\)/);
  // 作者信息必须在 fallback 之前取到，否则过滤用不上
  assert.ok(
    article.indexOf("const { name, authorHandle } = extractAuthor(article);") <
      article.indexOf("!isMetaLine(line, name, authorHandle)"),
    "extractAuthor 必须在 fallback 过滤之前"
  );
});

test("v2.3.8: 纯图片推文没有正文也允许生成", () => {
  const article = asyncFunctionBlock("runForArticle");
  const composer = asyncFunctionBlock("runForComposer");

  assert.match(article, /if \(!tweet\?\.tweetText && !tweet\?\.photos\?\.length\)/);
  assert.match(composer, /if \(!tweet\?\.tweetText && !tweet\?\.photos\?\.length\)/);
});

test("v2.3.8: 作者 handle 取不到时用 status 链接路径兜底", () => {
  const author = functionBlock("extractAuthor");
  assert.match(author, /fromPath/);
  assert.match(author, /\\\/\(\[A-Za-z0-9_\]\{2,20\}\)\\\/status\\\//);
});

// v2.3.11 — fallback 过滤后正文为空时，不能退回 article.innerText，
// 否则纯图片推文会把作者名、时间、阅读数、互动数当成推文内容。
test("v2.3.11: 正文为空时不退回 article.innerText", () => {
  const article = functionBlock("extractTweetFromArticle");

  assert.match(article, /const finalText = tweetText \|\| '';/);
  assert.doesNotMatch(article, /const finalText = tweetText \|\| allText/);
  assert.doesNotMatch(article, /const allText = article\.innerText/);
  assert.match(article, /const mentionedHandles = extractHandles\(tweetText\)/);
});

// v2.3.12 — 图片文字与原推译文共用顶部信息框，各占一行。
test("v2.3.12: 图片文字写入独立的 info 行，与原推译文互不覆盖", () => {
  const attachImage = asyncFunctionBlock("attachImageText");
  const sync = functionBlock("syncSourceBox");
  const panel = functionBlock("showDraftPanel");

  assert.match(source, /action: 'describePhotos'/);
  assert.match(attachImage, /data-kind="image"/);
  assert.match(attachImage, /line\.textContent = `图片文字：\$\{text\}`/);
  assert.match(sync, /querySelectorAll\('\.akiii-draft-source-line'\)/);
  assert.match(sync, /box\.hidden = !hasContent/);
  assert.match(panel, /attachImageText\(panel, photos\)/);
});

// v2.3.13 — 候选下方的中文译文可编辑，改完按新意思重写上方候选。
test("v2.3.13: 译文行可编辑，输入后防抖回写候选", () => {
  const attach = asyncFunctionBlock("attachTranslations");
  const bind = functionBlock("bindRewriteOnEdit");

  assert.match(attach, /line\.contentEditable = 'true'/);
  assert.match(attach, /bindRewriteOnEdit\(line, item, index\)/);
  assert.match(source, /action: 'rewriteReply'/);
  assert.match(bind, /setTimeout\(run, 900\)/);
  assert.match(bind, /textarea\.value = next/);
  assert.match(bind, /line\.dataset\.akiiiSyncedFor/);
  // 期间又改过就放弃旧结果，避免覆盖用户最新输入
  assert.match(bind, /!== meaning\) return;/);
});

// v2.3.14 — 主帖详情页里，取当前条之前的 article 作为线程语境。
test("v2.3.14: 提取主帖与上一条评论，不改回复对象", () => {
  const thread = functionBlock("extractThreadContext");
  const article = asyncFunctionBlock("runForArticle");

  assert.match(thread, /\[\.\.\.document\.querySelectorAll\(ARTICLE_SELECTOR\)\]\.filter\(isVisible\)/);
  assert.match(thread, /articles\[0\]/);
  assert.match(thread, /articles\[index - 1\]/);
  assert.match(thread, /slice\(0, 600\)/);
  assert.match(article, /tweet\.threadRoot = thread\.rootText;/);
  assert.match(article, /tweet\.threadPrev = thread\.previousText;/);
});
