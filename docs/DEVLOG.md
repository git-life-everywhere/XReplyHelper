# DEVLOG — X 推文互动回复器

> 格式约定：最新版本在最前。每条迭代包含「确定方案 / 实施细节 / 状态」三段。
> v1.x 早期版本没有 DEVLOG 沉淀，无法精确回填，保留占位以备后续考古。

---

## v2.3.14 — 2026-11-23 — 回复评论时带上线程语境

**确定方案**

使用者的场景：主帖 A → 有人评论 B → 他要回复 B。原来插件只把 B 发给模型，回复不知道这句话是在什么讨论里说的。

诉求确定为三层：主帖、当前要回复的评论、这条评论的上一条。顺序上足够支撑「这句话在回应什么」的判断，又不至于把整页塞进 prompt。

限制来自 X 的页面结构：只有**主帖详情页**里推文才按线程自上而下排列；单条推文详情页、时间线、回复弹窗里，更上层的内容压根没有渲染。所以能力只在主帖详情页生效，其余场景自动退化。

**实施细节**

- `content.js`
  - 新增 `extractThreadContext(article)`：取页面上可见 article 序列，当前条之前的 `articles[0]` 作为主帖、`articles[index - 1]` 作为上一条；各截断 600 字符。
  - `runForArticle()` 把结果挂到 `tweet.threadRoot` / `tweet.threadPrev`，不改回复对象。
- `background.js`
  - `buildInput()` 新增「线程语境」段，标注「只用来理解这句话在讨论什么，不要直接回复它们」。
  - 上一条与主帖文本相同时去重，不重复输出。
- `tests/`
  - 新增 4 条：拼上语境、无语境时不出现该段、重复文本去重、内容脚本提取路径。

**状态**

已交付。`node --test tests/*.test.mjs` 111/111 全绿。

**遗留**

- 只在主帖详情页生效。时间线与单条推文详情页拿不到上层内容，行为与之前一致。
- 固定取两条（主帖 + 上一条）。三层以上的长线程只带最近一层，中间层不带。
- 上下文各截断 600 字符，超长主帖会丢尾部。

## v2.3.13 — 2026-11-23 — 译文可编辑，改完自动重写候选

**确定方案**

使用者反馈：AI 生成的英文候选不合适时，只能整条自己重打。英文不是母语的话，改英文比改中文难得多。

诉求明确：候选下方的中文译文要能编辑；改完译文后，插件按新意思重写英文候选并覆盖上去。

也就是把中文当作输入源。判断标准从「这句英文对不对」降到「这个中文意思对不对」，门槛低很多。

**实施细节**

- `background.js`
  - 新增 `REWRITE_INSTRUCTIONS` 与 `rewriteReply(text)`：把中文改写成自然英文，要求口语、简短、不翻译腔、长度与中文相当。
  - `chrome.runtime.onMessage` 新增 `rewriteReply` 动作。
- `content.js`
  - `.akiii-draft-translation` 由普通 div 改为 `contentEditable`，补 `role="textbox"` 与 `aria-label`。
  - 新增 `requestRewrite()` 与 `bindRewriteOnEdit(line, item, index)`：
    - `input` 防抖 900ms，`blur` 立即执行
    - 回写前校验译文没再变（`!== meaning` 就放弃），避免覆盖用户最新输入
    - 成功覆盖 `textarea.value` 并提示「候选 N 已按译文重写」
    - 用 `dataset.akiiiSyncedFor` 记录已同步文本，防止重复请求
- `content.css`
  - 译文可编辑态：`cursor: text`、聚焦时左边线加重、空内容时显示提示「改这里的中文，候选会按新意思重写」。
- `tests/`
  - 新增 3 条：改写成功、空译文不请求、译文可编辑且防抖回写。

**状态**

已交付。`node --test tests/*.test.mjs` 107/107 全绿。

**遗留**

- 回写只覆盖候选文本，不更新已同步标记之外的元数据；若用户连续改两次中文，第二次会重新请求，不缓存。
- 改写目标语言固定为英文。候选若是日文等其他语言，改中文会得到英文，目前只在英文场景验证过。
- 译文行为空时 `:empty::before` 显示提示，但用户删空后不会自动清空候选——保持原样更安全。

## v2.3.12 — 2026-11-23 — 提取图片里的文字并显示在草稿窗顶部

**确定方案**

一条正文只有 `#quote`、配了一张名言图的推文，候选围绕图里的「silence is a sign of wisdom」展开，说明模型确实读到了图。但使用者看不到图里写了什么，只看到顶部一行 `#quote`，容易误以为抓错了。

需求因此明确：把图片里的文字提取成文本，显示出来。

两种做法：让主生成请求顺带返回 `imageText` 字段，或单独发一次视觉请求。选后者——先前吃过教训，给生成加复杂输出格式会让本来就短的小模型更不稳定，而且失败会连累主流程。

**实施细节**

- `background.js`
  - 新增 `PHOTO_TEXT_INSTRUCTIONS` 与 `describePhotos(rawPhotos)`：走 `loadPhotos()` 下载（最多 2 张，这一步只为人看个大概），复用 `callModel()` 做视觉请求，返回纯文本，最长 600 字符。失败返回空字符串。
  - `chrome.runtime.onMessage` 新增 `describePhotos` 动作。
- `content.js`
  - `showDraftPanel(initialReplies, editor, sourceText, photos)` 增加第四个参数。
  - 顶部信息框改为两行结构：`data-kind="tweet"`（原推译文）与 `data-kind="image"`（图片文字）。
  - 新增 `syncSourceBox(panel)`：任一子行有内容才显示整个框。
  - 新增 `requestPhotoText()` 与 `attachImageText()`，后者异步填充，不阻塞草稿窗。
- `content.css`
  - 新增 `.akiii-draft-source-line + .akiii-draft-source-line`：两行之间的分隔线与间距。
- `tests/`
  - 新增 4 条：文字提取成功、关闭图片理解时不请求、无图不发请求、图片文字写入独立行。

**状态**

已交付。`node --test tests/*.test.mjs` 104/104 全绿。

**遗留**

- 图片文字用的是与主生成相同的模型。若模型不支持视觉（如 `deepseek-v4-pro`），这一步会静默失败，顶部不显示图片文字，不报错。
- 只读最多 2 张图，第 3 张及以后不参与文字提取。
- 提取结果只用于展示，没有回填进生成提示词——模型仍靠自己看图，而不是靠这段文字。

## v2.5.0 — 2026-11-23 — 提示词砍到极简，规则从 22 条降到 8 条

**确定方案**

v2.4.0 刚把提示词整理成四段、22 条规则，覆盖了此前所有已知偏差。但同一条 Paulo Coelho 引言推文，输出仍是读后感体。

使用者做了一次对照：把同样的推文发给 DeepSeek 网页版，只写了一句「这是一个英文帖子，我现在要回复他，你给我看下我怎么回复合适：用英文回复，并且给翻译」。返回的四条是：

- `This hits hard. Needed to hear this today — thank you for the reminder.`
- `So true. We always think there's more time until suddenly there isn't. Time to stop waiting.`
- `Powerful reminder. No more 'someday' — starting today.`
- `This one stopped me mid-scroll. Thanks for the push — I really needed it.`

短、直接、有感谢、第一人称。全是人话。

关键发现：这四条里有两条在评价这句话（`This hits hard`、`Powerful reminder`），两条在处理谢意——**而插件的规则明确规定「不评价原推写得怎么样」**。也就是说，插件此前一直在禁止的，恰恰是好回复里最常见的东西。

结论：规则数量本身就是问题。模型在 22 条约束里权衡时，注意力花在「满足规则」上，产出的是合规产物而非回复。

**实施细节**

- `background.js`
  - `buildInstructions()` 重写，篇幅 1481 → 约 300 字符，规则 22 → 8 条。
  - 保留：语言、长度、数量与输出格式、不编造、图片不描述画面、禁用词、风格、额外提示词。
  - 删除：三条分工、信息边界整段（不改褒贬、提问先答、不换例子、单条单立场等），以及「有观点，有棱角」「不评价原推写得怎么样」这类反向措辞。
  - 初版写「可以认同、感谢、补充、调侃、自嘲，怎么自然怎么写」，实测把模型引向自嘲玩梗——三条全是「我也有这毛病」「读了又回去刷手机」。该句随即删除，提示词收敛到 4 条行为约束。
- `tests/background.test.mjs`
  - 重写提示词断言：检查保留的硬约束存在、旧的重量级规则已移除，并加长度上限断言（提示词 < 700 字符）。

**状态**

已交付。`node --test tests/*.test.mjs` 99/99 全绿。

**遗留**

- 撤掉整段信息边界后，「把 good 说成 factory」「问在读什么却答感受」这两类问题可能复发。已做好「复发再单点补一条」的准备，不预先把规则堆回去。
- 「本次风格」与极简提示词略有重复（都在讲短、口语），暂未删，保留一个可调旋钮。

## v2.4.0 — 2026-11-23 — 提示词整体重构，从 29 条禁令压到 22 条

**确定方案**

从 v2.3.1 到 v2.3.10，每次偏差都靠加规则解决，累计到 29 条（默认声音 17、信息边界 10 及若干补充）。结果是同一条 Paulo Coelho 引言推文，改了四轮仍输出读后感体：`This line hits harder the older you get`（评价引言效果）、`most people don't know what the 'it' is`（拆解分析）。

诊断出三个结构性问题：

1. **位置决定权重，而非重要性**。决定输出形态的「三条角度要明显不同」在数量规则段，位于 prompt 开头；后加的「允许纯共鸣」在中段。模型只抓最显眼的那几条。
2. **禁令过多，缺少正向指令**。规则里九成是「不要…」，模型知道不能写什么，不知道该写什么，只能按自己的默认倾向填。
3. **措辞一旦绝对化，模型就往极端推**。`有观点，有棱角` → 评论员腔；`主要在讲自己` → 每条必讲经历；`只用图片里看得见的内容` → 描述人物表情。三次都是同一个规律。

所以不再打补丁，改为整体重构。

**实施细节**

- `background.js`
  - `buildInstructions()` 重写，篇幅 2564 → 1481 字符，规则 29 → 22 条。
  - 新结构四段：任务与约束（语言/长度/数量）→ **三条分工**（表态 / 经历 / 补充）→ 怎么写 → 信息边界。
  - 「三条角度要明显不同」不再作为抽象要求，改为具名分工：表态型一句话说完、经历型讲一件小事、补充型落在原推那件事上。
  - 合并「默认声音」与「去 AI 味」两段，删掉重复项。
  - 清理被外推的措辞：`有观点，有棱角`、`主要在讲自己`、`只用图片里看得见的内容`。
  - `STYLE_MAP.sharp` 去掉「有棱角」。
- `tests/background.test.mjs`
  - 重写提示词相关断言：改为检查四段结构、三条分工、信息边界条目与动态参数（语言/长度/输出格式）。
  - 用例总数 99。

**状态**

已交付。`node --test tests/*.test.mjs` 99/99 全绿。

**遗留**

- 三条分工是硬约束，若模型仍把「补充」写成论述，需要再细化它的边界，而不是加新规则。
- 规则从 29 降到 22，但「三条分工」可能带来新问题：三条候选风格差异变小。需实测确认。
- 本次只调提示词，未动解析与清洗链路。

## v2.3.9 — 2026-11-23 — 回复改为直接表态，图片只用于理解语境

**确定方案**

一条 Paulo Coelho 的「现在就做」引言推文，三条候选仍是读后感体：`This quote hits differently every year`（评价引言的效果）、`Look at his face there. Completely calm, patient, almost amused`（分析配图人物表情）、`Trouble with "do it now" is…`（反驳并给方法）。

使用者给出了自己的真实回复：「是的，时间宝贵，现在就开始做自己最想做的事情，不留遗憾！！！」——直接表态，短，有情绪，不分析、不举例。

两个问题由此暴露：

1. v2.3.7 把方向改成「主要在讲自己：具体的小例子、真实的经历、一句自嘲」，模型理解成「每条都必须讲一段经历」，反而更远离普通评论的样子。真人很多时候就是直接表态。
2. 配图只是一张人物照片，没有任何文字。v2.3.8 的规则「只用原推文字和图片里看得见的内容」被模型理解成「画面里的一切都可以写」，于是去描述长相、表情、神态。图片本该用来理解语境，不是用来转述的。

**实施细节**

- `background.js`
  - `- 主要在讲自己：一个具体的小例子、一次真实的经历、一句自嘲` → `- 顺着原推表态：认同就说认同，有感触就说感触；讲自己的经历只是其中一种，不必每条都讲`
  - `- 有判断，但判断要落在自己的经历上，不要为了显得有棱角而写论述` → `- 有判断，但不要为了显得有棱角而写论述`
  - `- 论述限于一两句，其余用具体的事支撑；宁可讲一件小事，不要讲一个道理` → `- 论述限于一两句，宁可短，不要展开成一篇`
  - 信息边界首条拆成两条：`信息只能来自原推文字和图片。图片只用来看懂语境，不要转述画面：不描写人物长相、表情、神态、衣着、场景`；`不要编造原文没有的具体事物`
- `tests/background.test.mjs`
  - 断言同步到新文案，含图片不转述画面这条。

**状态**

已交付。`node --test tests/*.test.mjs` 98/98 全绿。

**同一轮追加（v2.3.10）**

使用者给出自己在同一条推文下的真实回复：「是的，时间宝贵，现在就开始做自己最想做的事情，不留遗憾」。这条回复全程没有新信息——没有补充观点、没有举例、没有反驳，只是把原推的意思用自己的话加重说了一遍。

由此发现提示词里缺一条根本性许可：**从没有允许「不增值」的回复**。相反「每条角度要明显不同」在逼模型每条都找新角度，于是永远是分析、举例、反驳。

补两条（连同 v2.3.9 的「顺着原推表态」共三条方向性调整）：

- 认同型回复可以只是把原推的意思用自己的话说一遍、加重语气，不必补充新信息、新角度、新方法
- 不是每条都要「提供价值」，共鸣本身就是一种合格回复；三条里允许有一条就是纯粹的共鸣

**遗留**

- 规则总数 29 条。这次是通过改方向而非加条数解决的，但同一类问题（模型偏到另一头）已经出现三次：有棱角→论述体、讲经历→必须举例、用图片→描述画面。说明单条规则的措辞极易被外推，后续调整应优先考虑「删掉旧的、改成正向描述」，而不是在原规则后面补否定句。
- 「顺着原推表态」与信息边界里「原推在分享感受时不要挑刺」语义重叠，暂未合并。若后续出现规则互斥，优先合并这两条。

## v2.3.8 — 2026-11-23 — 修复回复里误带 @ 与元信息污染正文

**确定方案**

使用者反馈某条推文的候选末尾多了 `@Literatureomar1`，那正是作者自己的 handle。

两条链路叠在一起：一是这条推文正文抓不到，走 `extractTweetFromArticle()` 的 fallback，克隆节点取 `innerText`；fallback 只过滤了 `Reply / Like / Share` 这类按钮文字，作者名、handle、阅读数全部留下，凑出一行 `Literature@Literatureomar1.3K` 当成推文内容。二是 `mentionedHandles` 本该排除作者本人，但它依赖 `extractAuthor()` 取到 `authorHandle`，该推文结构里 `User-Name` 区块没命中，`authorHandle` 为空，排除失效。最后 `buildInput()` 把这枚 handle 写进「可用项目方 @账号」，模型按项目规则带在末尾。

同类问题此前已出现过两次（`@readswithravi`、Bradbury 那条），说明「自动使用推文里扫到的 handle」这个设计本身不稳。

**实施细节**

- `background.js`
  - `buildInput()` 的可带 @ 只取 `projectHandle`，不再合并 `mentionedHandles`。
  - 项目规则改写为：只有用户配置了关联账号、且推文确实涉及该账号所属方时才带；原文里出现的作者本人与路人 handle 一律不加。
  - 正文为空且带图时，写入「（原推没有文字，只有图片）」，避免模型面对空白自由发挥。
- `content.js`
  - 新增 `isMetaLine(line, authorName, authorHandle)`：过滤作者名、作者 handle、纯阅读数（`1.3K` 这类）、相对时间、分隔符。
  - `extractTweetFromArticle()` 把 `extractAuthor()` 提到 fallback 之前，过滤才能用上作者信息。
  - `extractAuthor()` 增加兜底：`User-Name` 区块取不到时，从 `a[href*="/status/"]` 的路径里取用户名。
  - `runForArticle()` / `runForComposer()` 的硬判断改为「没有文字也没有图片」才报错，纯图片推文不再被判为无内容。
- `tests/`
  - 新增 3 条：fallback 过滤元信息且顺序正确、纯图片推文允许、作者 handle 兜底路径。

**状态**

已交付。`node --test tests/*.test.mjs` 98/98 全绿。

**遗留**

- `extractTweetFromDialog()` 还没加同样的元信息过滤，回复弹窗路径遇到正文缺失时仍可能带入作者名。
- 放弃自动使用 `mentionedHandles` 后，推文里真实提到第三方项目账号时也不会自动带上，需要用户自己填「默认关联 @账号」。这是有意取舍：宁可少带，不要错带。

## v2.3.7 — 2026-11-22 — 回复从「写论述」改为「讲自己的事」

**确定方案**

一条拖延主题的推文，三条候选全部是「判断 + 论证」结构：`The system framing is useful but…`、`Give me the next physical action…`、`Self-criticism is cheaper than…`。事实层面都对得上原文，但读起来像三段小评论，评论区里没人这么说话。

根因在「默认声音」第一条要求：`有观点，有棱角，有情绪`。模型把「有观点」执行成了「写一段论述」，因为提示词从没要求它讲自己的具体经历。原文本身是完整的建议，模型面对这种文本天然选择「评价它」而不是「参与对话」。

改法不是继续加禁令，是改方向：把「有棱角」降级为「有判断，但落在自己经历上」，并明确要求主要讲具体的小事。

**实施细节**

- `background.js`（默认声音段）
  - 删除 `- 有观点，有棱角，有情绪，但不要表演过度`。
  - 新增四条：
    - 有判断，但判断要落在自己的经历上，不要为了显得有棱角而写论述
    - 主要在讲自己：一个具体的小例子、一次真实的经历、一句自嘲
    - 不要评价原推的结构或逻辑（「这个框架有用但…」「大多数人以为…」），那是评论员的话
    - 论述限于一两句，其余用具体的事支撑；宁可讲一件小事，不要讲一个道理
- `tests/background.test.mjs`
  - 断言新四条存在，且旧的「有观点，有棱角，有情绪」已移除。

**状态**

已交付。`node --test tests/*.test.mjs` 95/95 全绿。

**遗留**

- 「有棱角」是早期为了拉开与模板化的差距加的，这次降级后，输出可能偏温吞。若实测发现三条候选都是「我也有同感」这类软话，需要把「判断」这一侧的权重再调回来，而不是重加「有棱角」。
- 规则总数已达 27 条（默认声音 17、信息边界 10）。相互挤压开始明显：信息边界里的「信息太少就只说那句话本身」与默认声音的「主要讲自己」在极短推文上会冲突，模型表现待观察。

## v2.3.6 — 2026-11-22 — 修复按钮复用导致的内容串台

**确定方案**

使用者反馈：一条卡夫卡语录的推文，三条候选里有一条明显属于页面下方另一条推文（Radish Reads 那条，文字几乎逐字相同）。

回看 `injectArticleButton()` 的复用分支：按钮被判定为同一推文时只更新 `dataset.akiiiStatusId` 和 DOM 位置，**没有更新 click 监听器**。而 click 里通过闭包捕获了创建时的 `article`。X 是虚拟列表，滚动时节点会被复用与重排，于是出现「按钮挂在 B 推文下、点击却用 A 推文生成」。

放大这个问题的是 `getStatusUrl()`——它取 article 内第一个 `/status/` 链接，而回覆类推文常带「回复 @xxx」的链接指向原推，两条推文因此算出同一个 statusId，被 `getArticleButtons()` 误判为同一条，触发复用。

方案：不在复用分支重新绑定监听（会丢禁用态），改为点击时按按钮当下的位置取上下文。

**实施细节**

- `content.js`
  - `AI回` 的 click 改为 `runForArticle(closestArticle(btn) || article, btn)`：优先用按钮当前所在的 article，取不到才退回闭包值。
  - `AI填入` 的 click 改为 `runForComposer(btn.isConnected ? btn : anchor, btn)`：锚点失效时退回。
- `tests/content-js.test.mjs`
  - 新增 2 条：断言两处都不再直接用过期闭包。

**状态**

已交付。`node --test tests/*.test.mjs` 95/95 全绿。

**遗留**

- `getStatusUrl()` 对回覆类推文仍可能取到原推链接，statusId 相同的问题没有根治，只是不再导致串台。彻底修需要区分「推文自身的 status 链接」与「回复指向的链接」。
- 按钮复用只更新了标记与位置，禁用态等运行时状态在跨推文复用时仍会残留。

## v2.3.4 — 2026-11-22 — 非中文原推也翻成中文，显示在草稿窗头部

**确定方案**

候选有了中文译文后，使用者提出还缺一环：原推本身是外文时，看得到回复、看不懂原推，没法判断回得对不对。

做法是把原推原文并入同一次翻译请求——追加到待翻译数组末尾，回填时前 N 条对应候选，第 N+1 条放进头部新增的展示位。这样不增加任何额外调用。

原推本来就中文时不翻译，展示位保持隐藏。原文超过 1200 字符先截断再送翻，避免长文拉高成本。

**实施细节**

- `content.js`
  - `showDraftPanel(initialReplies, editor, sourceText = '')` 新增第三个参数；头部与候选列表之间插入 `<div class="akiii-draft-source" hidden>`。
  - `attachTranslations(replies, panel, sourceText)`：原文非中文时追加进待翻数组（截断 1200 字符），回填时取 `translations[replies.length]` 写入展示位。
  - 展示位不再绑定折叠交互，直接写入译文。
  - 两个入口 `runForArticle()` / `runForComposer()` 调用时传入 `tweet.tweetText`。
- `content.css`
  - 新增 `.akiii-draft-source`：左侧竖线、灰底、`flex: 0 0 auto`。
  - 折叠方案已回退。先后试过两版：96px 常显 + 内部滚动，会把候选顶出视野；62px 折叠 + 点击展开，仍是补丁。最终去掉折叠，完整显示，同时把面板上限从 `min(760px, 88dvh)` 放到 `calc(100dvh - 24px)`——滚动条的成因是面板上限低于视口，而不是译文太长。
- `background.js`
  - `translateReplies()` 待翻条数上限由 5 提到 6（候选最多 5 条 + 原推 1 条）。
  - 翻译指令从「每一条回复」改为「每一段文本」。
- `tests/content-js.test.mjs`
  - 新增 1 条：断言展示位存在、原文截断与回填下标正确、中文原推不触发。

**状态**

已交付。`node --test tests/*.test.mjs` 91/91 全绿。

**遗留**

- 原推超过 1200 字符会先截断再翻，长文末尾内容不参与翻译。
- 原推译文最多显示 5 行，长文需在框内滚动查看；没有做「展开全文」交互。

## v2.3.2 — 2026-11-22 — 英文候选自动显示中文译文

**确定方案**

使用者反馈：候选多为英文，想第一时间知道意思，得自己再翻一遍。希望每条候选下方直接给中文。

两种做法可选：生成时让模型一并输出译文，或生成后单独发一次翻译请求。选后者，理由有三——不破坏现有的 JSON 解析链路；中文推文不必多花 token；翻译失败不会连累主流程。

译文异步填充：草稿窗先弹出来显示英文，翻译回来再追加，不阻塞查看。只在候选以拉丁字母为主时触发，中文候选直接跳过。

**实施细节**

- `background.js`
  - `DEFAULT_SETTINGS` 新增 `autoTranslate: true`。
  - 新增 `translateReplies(texts)`：最多 5 条，走 `callModel()`，用独立的 `TRANSLATE_INSTRUCTIONS`（只输出 JSON 数组、不解释不扩写、保持口语）。无 Key 或开关关闭时返回空数组，不发请求。
  - `chrome.runtime.onMessage` 新增 `translateReplies` 动作。
- `content.js`
  - 新增 `needsTranslation(replies)`：首版用「拉丁字母数 > 中文字符数 × 3」判定需要翻译。
  - 同日改为 `isMostlyChinese(text)` + `!isMostlyChinese()`：翻译对象从英文扩到所有非中文。日文里大量汉字会被 CJK 区间命中，只看汉字数会把日文误判成中文，因此先用 `\u3040-\u30ff`（假名）与 `\uac00-\ud7af`（谚文）排除日韩，再按中文字符占「中文+拉丁字母」的比例是否大于 0.6 判定。
  - 新增 `requestTranslations(texts)`：无 `chrome.runtime.id` 时直接返回空，避免扩展重载后报错。
  - 新增 `attachTranslations(replies, panel)`：拿到译文后按顺序往每条候选追加 `.akiii-draft-translation`，已有译文的跳过。
  - `showDraftPanel()` 渲染完成后调用，不 `await`。
- `content.css`
  - `.akiii-draft-panel` 高度由固定 `min(680px, 86dvh)` 改为 `height: auto` + `min-height: min(320px, 60dvh)` + `max-height: min(760px, 88dvh)`。加译文后每条候选多一行，固定高度会立刻触发内部滚动，改成随内容走、到上限才滚。
  - 移动端 `@media` 同步。
  - 新增 `.akiii-draft-translation`：左侧竖线、灰色小字、`text-indent: 0`（避免继承候选文本框的 70px 首行缩进）。
  - 译文 `margin-right: calc(var(--akiii-action-button-width) + 12px)`，右边缘与上方文本框对齐。首版没设，译文作为 `.akiii-draft-candidate` 的直接子元素占满整行宽，视觉上压到了右侧「复制 / 填入 X」按钮列。
- `options.html` / `options.js`
  - 回复设置新增「英文候选自动显示中文译文」开关。
- `tests/`
  - 新增 5 条：翻译成功、关闭开关不发请求、无 Key 不发请求、内容脚本只在英文时请求、译文样式独立。

**状态**

已交付。`node --test tests/*.test.mjs` 89/89 全绿。

**遗留**

- 翻译与主生成共用同一个渠道和模型。若模型本身翻译质量一般，译文会带模型腔；将来可考虑允许译文走单独的低成本渠道。
- 译文按数组下标与候选对齐。若模型返回条数少于输入，末尾几条会没有译文，目前不补位也不报错。
- 候选少于 3 条时，译文仍按实际条数请求，不浪费额度。

## v2.3.1 — 2026-11-22 — 加信息边界规则，禁止编造原文没有的场景

**确定方案**

使用者反馈：一条只有图片、正文为空的推文（图里是 “Sometimes, just to begin, you only need a glass of water.”），生成的候选 1 出现了 `just open the document`。图里没有任何关于文档、工作的信息，这个词是模型自己补的。同一条候选前半句否定「仪式」、后半句又说 `whatever gets you moving is fine`，立场自相矛盾。

图片链路本身没问题——三条候选都围绕 `glass of water` 展开，说明图读到了。问题是图里只有 8 个词，模型要凑出 3 条各 30 词的候选，信息不够就自由发挥。而 v2.3.0 的提示词只约束了语气与领域，没有约束信息边界。

使用者当时在「额外提示词」里放了一份语气规则，管住了口语化与接梗，但同样不管内容边界。方案定为写进代码：内容边界属于产品级规则，且代码位置比额外提示词靠前，权重更高。

**实施细节**

- `background.js`
  - `buildInstructions()` 新增「信息边界」段，位置在「默认声音」之后、「本次风格」之前：
    - 只用原推文字和图片里看得见的内容，不编造原文没有的具体事物（文档、会议、项目、客户、老板这类）
    - 信息太少就只说那句话本身，不替作者补背景、补场景
    - 每条候选只持一个立场，不一边否定一边又说「也行」
    - 原推在分享感受、没有可争论的观点时，顺着共鸣或讲讲自身体验，不挑刺、不找漏洞、不为显得有观点而反驳
    - 不篡改原文的评价倾向：原文说好就是好，不翻成负面；原文在抱怨，也不硬转成积极
    - 三条候选的差异来自同一件事的不同侧面，不靠换话题、引入原文没有的新概念来制造差异
    - 不编造原作没有的具体数字、年份、地点
    - 不把原文举的例子换掉或重新归类：原文举哪个例子就沿着说，不改换成别的类别，不给原文没提的东西新建分类
    - 原推在提问时先直接回答，再补充，不绕开问题只谈感受
    - 回答涉及的书名、作者、数字不确定时，用类型或模糊说法，不硬编
- `tests/background.test.mjs`
  - 新增 1 条：断言提示词含上述三条规则。
- 文档
  - `docs/开发概要说明书.md` 3.2.1 补提示词分层说明与信息边界的成因。

**状态**

已交付。`node --test tests/*.test.mjs` 84/84 全绿。

补充（同日，两批共四条）：实测一条 Bradbury 书味引文的推文后，第一批加了两条——原推在分享感受、没有可争论的观点时，顺着共鸣或讲自身体验，不挑刺；不篡改原文的评价倾向。起因是模型把原推「新书味好、旧书味更好」里的新书说成 `smell like a factory`，并去挑「只有两种」这个说法的漏洞。

第二批两条的触发是同一条推文的下一轮生成：一条把新书味贬成 `glue and a factory` 并编了 `a cracked spine from 1974`；另一条从「书的气味」扯到 `we refuse to go full e-reader`，硬开新议题。根因是模型把「角度要明显不同」理解成「必须换点别的说」，于是靠站队和换话题制造差异。规则改为：差异只能来自同一件事的不同侧面，且不编造原作没有的数字、年份、地点。

第三批一条的触发是同一类推文的又一次生成：原文举例「高薪耗命的工作」「易坏的便宜货」，候选把「便宜易坏」说成「小账单」，又把「昂贵的部分」具象成「订阅、习惯、义务」，等于换了原文的例子还反了逻辑。前两批规则管的是「不许加词」，模型用「类比替换」绕过，所以补一条针对换例子的规则。

第四批两条的触发是一条提问型推文（「Lazy day. Heaven! What are you reading?」）：三条候选里两条只附和情绪、没回答在读什么。提示词里的「语气跟随」把「提问」归进了语气分类，却只要求「用同一种语气回」，没要求「回答问题」。同时模型为凑答案写了 `a slow mystery`——它并不知道使用者真在读什么。

详情见 3.2.1 的信息边界表。

**遗留**

- 正文为空、只有图片的推文信息量本来就少，规则只能约束「不编」，无法凭空增加可用信息。这类推文的候选质量上限仍然低于正文完整的推文。
- 额外提示词位于整段末尾，权重最低。若使用者继续在其中堆规则，与代码里的固定规则冲突时，固定规则更容易被稀释。

## v2.3.0 — 2026-11-22 — 从 Crypto KOL 专用改为通用回复插件

**确定方案**

实测中使用者发现，一条读书号讲 Thoreau 的推文，生成的回复硬往炒币上扯（「Every hour glued to charts is life exchanged for a candle」），另一条去扒 Thoreau 本人的房租谁付。逻辑能挂上原文，但视角错位。

根因在 `buildInstructions` 的「默认声音」：`- 像真实 Crypto / Web3 KOL 在回推，不像 AI`。这行无条件生效，模型对任何推文都戴 crypto 眼镜；KOL 腔里的「拆穿别人」又催生了攻击作者资历那条。

插件最初面向加密 KOL，这行是早期设定。要把产品做成通用回复工具，得把「行业视角」从默认改成按需。

**实施细节**

- `background.js`
  - 「默认声音」首条 `像真实 Crypto / Web3 KOL 在回推` 改为 `像真实的人在回推`。
  - 新增两条：按原推领域（科技、商业、读书、生活、情绪、娱乐、加密）选择说话方式；仅当原推本身涉及 Crypto / Web3 时才用行业视角。
  - 新增 `不要攻击原作者的身份、资历或人品，只回应观点本身`。
  - 项目规则里的「项目方」改为「品牌、项目或机构」，「明确项目方账号」改为「明确账号」。
  - 营销腔禁词补 `底层逻辑`、`方法论`、`颗粒度`。
  - `STYLE_MAP.sharp` 文案里的 `KOL` 改为 `真人`。
- `options.html`
  - 「默认项目方 @账号，可空」改为「默认关联 @账号，可空」，占位示例换成中性例子。
- `README.md`
  - 定位段改为「通用的 X / Twitter AI 回复辅助扩展」，说明按领域自适应；使用场景从纯 KOL 扩到读书/科技/商业/生活创作者；配置说明与功能列表同步改名。
- 文档
  - `docs/使用说明书.md` 使用对象与配置表同步；`docs/开发概要说明书.md` 字段说明同步。
- `tests/background.test.mjs`
  - 新增 1 条：断言提示词含领域自适应与「不攻击原作者」，且不再出现旧 KOL 文案。

**状态**

已交付。`node --test tests/*.test.mjs` 83/83 全绿。版本号统一提升到 `2.3.0`：`manifest.json` 的 `version` 与 `description`、`content.js` 草稿窗 fallback、`README.md` 标题与版本节点、两份文档标题与版本标注、共享功能描述表。

**遗留**

- 视觉与命名仍带早期痕迹：草稿窗标题、仓库名、README 里「X 推文互动回复器」未改，属产品名范畴，改名需一并处理安装目录与 zip 文件名。
- `manifest.json` 版本号仍为 `2.2`，DEVLOG 已积累 2.2.1 至 2.2.5 与 2.3.0。发版时需统一提升并同步 README 版本节点与草稿窗 fallback 版本号。

## v2.2.5 — 2026-11-22 — 丢弃被截断的英文候选残句

**确定方案**

使用者反馈候选里出现半句话，例如 `Thoreau was measuring what he'd already chosen to give up, not what he was forced to`，末尾停在 `to`。成因是生成撞上 `max_tokens`，模型写到一半被切断；`splitReplyText` / `extractQuotedStrings` 只能捞到已写出的部分，没有完整性判断。

判断「截断」不需要知道 token 用量，看末尾词就够：完整英文句子极少以虚词收尾。据此加一层过滤，命中即整条丢弃，宁可少一条也不给用户半句。

阈值定为 8 词：`I think so`、`That is what it is` 这类短句本来就会以虚词结尾，不参与判定。

**实施细节**

- `background.js`
  - 新增 `TRUNCATED_ENGLISH_TAIL` 正则，覆盖 `and / or / but / to / of / in / on / with / that / which / the / a / an / is / was / are / were / for / as / at / by / if / so / than / then / when / while / not`。
  - 新增 `looksTruncatedEnglish(reply)`：8 词以下不判定；末尾词去掉标点后与正则匹配即视为截断。
  - `cleanReplyCandidates()` 增加第三层过滤，仅英文场景生效（判据与 `cleanReply` 的长度规则一致）。
- `tests/background.test.mjs`
  - 新增 3 条：末尾虚词判截断 / 短句不误杀 / 英文场景下截断候选不进入最终结果。

**状态**

已交付。`node --test tests/*.test.mjs` 82/82 全绿。

**遗留**

- 中文候选没有对应的截断判定。中文截断多由长度硬截造成，`cleanReply` 会优先取首个完整分句，暂未观察到残句。
- 若模型连续三轮都产出残句，草稿窗可能只有 1-2 条候选，不会报错。这是「宁缺毋滥」的既定取舍。

## v2.2.4 — 2026-11-22 — 草稿窗加宽加大，长候选不再被截

**确定方案**

使用者反馈候选文字显示不全：面板固定 490×490，每条候选文本框只有 112px 高（`max-height: 124px`），英文候选写到五六行就得在框里滚；面板 `overflow: hidden`，三条加起来超过 490 时最后一条还会被直接裁掉。

改法是把空间让出来，而不是让用户拖滚动条：面板加宽到 560px、高度放到 680px（视口 86% 封顶），候选框高度 112px → 148-168px。同时给面板加 flex 纵向布局、候选列表 `flex: 1 1 auto` + `overflow-y: auto`，小屏或超长文本时由列表滚动兜底，不再被 `overflow: hidden` 裁掉。

**实施细节**

- `content.css`
  - `.akiii-draft-panel`：`width` 490 → 560px，`height` / `max-height` 由 `min(490px, 60dvh)` 改为 `min(680px, 86dvh)`；新增 `display: flex` + `flex-direction: column`。
  - `.akiii-draft-text`：`height` `clamp(108px, 13dvh, 112px)` → `clamp(148px, 17dvh, 168px)`，`min-height` 82 → 112px，`max-height` 124 → 200px。
  - `.akiii-draft-list`：新增 `flex: 1 1 auto`、`min-height: 0`、`overflow-y: auto` 与滚动条配色。
  - 移动端 `@media (max-width: 760px)` 同步：面板高度 `min(680px, 86dvh)`，文本框 `clamp(120px, 18dvh, 150px)`。
- `tests/content-css.test.mjs`
  - 5 处尺寸断言同步到新值。
- 文档
  - `docs/使用说明书.md`、`docs/开发概要说明书.md`、`docs/style-cards/共享-功能描述表.md`、`README.md` 里的 490px 描述统一改成 560px，并补上「列表整体滚动」的行为说明。

**状态**

已交付。`node --test tests/*.test.mjs` 79/79 全绿。

**遗留**

- 截图 `docs/readme_img/XReplyHelper_490.png` 仍是 490px 时期的界面，与本版尺寸不一致，重截后需替换。
- 面板变高后在小视口（如 720p 笔记本半屏）会占掉较多画面，若影响使用可再降到 640px。

## v2.2.3 — 2026-11-22 — 生成前展开折叠的长推文

**确定方案**

使用者反馈：点 `AI回` 后生成的回复与推文内容对不上。截图里那条推文正文三段，弹窗中显示 `Show more`。

原因不在弹窗：`runForArticle()` 读的是时间线上的 `article`，而 X 对长推只渲染折叠版，`div[data-testid="tweetText"]` 里就是半截正文，`innerText` 拿不到后半段。`AI填入` 走 `extractTweetFromDialog()`，弹窗里的原推同样是折叠态，问题一样。所以这不是某个入口的 bug，而是「读取时文本本就不完整」。

使用者给了两个方案：一是自动展开后生成，二是 `AI回` 只开弹窗、生成交给 `AI填入`。选前者：方案二改不了读取结果，`AI填入` 读的仍是折叠文本，只是多点一次按钮。

**实施细节**

- `content.js`
  - 新增 `SHOW_MORE_SELECTOR`，值为 `[data-testid="tweet-text-show-more-link"]`。
  - 新增 `findShowMore(root)`：先按 testid 找，找不到再按 `Show more` / `显示更多` / `展示更多` 文案兜底；兜底时排除位于 `div[data-testid="tweetText"]` 内的同名节点，避免正文里恰好写了这几个字被误点。
  - 新增 `expandLongTweet(root)`：命中后 `clickLikeUser()` 点击，等待 360 毫秒让文本渲染完，返回是否真的展开过。
  - `runForArticle()` 在 `extractTweetFromArticle()` 之前调用，展开成功时提示「已展开长推文」。
  - `runForComposer()` 在 `extractTweetFromContext()` 之前对所在弹窗调用。
  - 新增 `waitForDialog(timeout)`，`runForArticle()` 打开回复弹窗后用它拿到弹窗，再异步展开弹窗内原推。此处刻意不 `await`：正文已从时间线读到，这只是让弹窗视觉上也展开，不该拖慢生成。
- `tests/content-js.test.mjs`
  - 新增 1 条：断言展开先于读取，且展开控件选择器与文案兜底都在。

**状态**

已交付。`node --test tests/*.test.mjs` 79/79 全绿。

**遗留**

- 折叠控件的 DOM 结构依赖 X 当前实现。`data-testid` 失效时靠文案兜底，若中英文案同时改动则展开会失效，退回读折叠文本，不会报错但内容会缺。
- 展开动作会改变页面布局，长推展开后同屏推文位置下移，时间线场景需留意后续扫描是否会重复注入按钮。

## v2.2.2 — 2026-11-22 — 推文图片理解（多模态）

**确定方案**

v2.2 只把推文文字发给模型，图片完全没采集。加密与 Web3 场景里大量推文正文只有一两句，信息都在 K 线截图、公告图、海报和 meme 里，模型不看图只能泛泛而谈。

README 早前列过多模态方案，当时建议先做轻量版（只取 alt 文本）。实测判断放弃：X 的 `alt` 由作者手动填写，命中率很低，做了大概率感觉不到变化。直接走完整版，把图片真正交给模型。

按使用者要求定为默认开启、默认读 3 张。为了不让成本与兼容风险失控，同时加两条硬约束：上限 4 张、单张超 5MB 跳过；渠道不接受图片时自动退回纯文本。

**实施细节**

- `content.js`
  - 新增 `extractTweetPhotos(root)`：查 `img[src*="pbs.twimg.com/media"]`，`name` 参数统一改 `small`，同时取 `alt`，最多 4 张。
  - `extractTweetFromArticle()` 与 `extractTweetFromDialog()` 的返回值都加 `photos`，弹窗内联回复也能读到原推图片。
- `background.js`
  - `DEFAULT_SETTINGS` 新增 `visionEnabled: true`、`maxPhotos: 3`。
  - 新增 `loadPhotos()`：逐张 `fetchWithTimeout()`（15 秒），校验 `content-type` 以 `image/` 开头、体积不超 5MB，`bytesToBase64()` 编码后缓存。任何一张失败只记日志并跳过。
  - 新增四个协议拼装函数：`chatContentWithPhotos()`、`responsesInputWithPhotos()`、`geminiPartsWithPhotos()`、`anthropicContentWithPhotos()`。
  - 四个 `request*()` 增加 `photos` 参数；`callModel()` 抽出 `send(list)`，带图失败时退回 `send([])` 重试一次。
  - `buildInput()` 增加 `photoCount`，带图时追加一句说明图片数量与可用信息。
  - `generateReplies()` 在进入三轮重试前统一 `loadPhotos()` 一次，三轮复用同一批 base64。
- `options.html` / `options.js`
  - 回复设置新增「识别推文图片」开关与「最多读取图片数量」输入（1-4），保存时夹紧到合法区间。
- `tests/`
  - 新增 8 条：anthropic / openai_chat / gemini 三种协议的多模态入参形态、图片数量截断、关闭开关后不下载、渠道拒绝图片时退回纯文本，以及内容脚本抓图与 `photos` 字段的静态断言。
- 文档
  - 模块数从 7 改为 8，同步 `docs/使用说明书.md`、`docs/开发概要说明书.md`、`docs/style-cards/共享-功能描述表.md`。
  - 开发概要新增 4.5 节「推文图片理解」，5.2 补「图片降级层」。

**状态**

已交付。`node --test tests/*.test.mjs` 77/77 全绿。`manifest.json` 版本号仍为 `2.2`，本条目按行为版本记为 2.2.2，发版时统一提升。

**遗留**

- `4.5` 里 Anthropic 的图片块放在 text 块之前。Anthropic 官方文档对顺序无硬性要求，但部分兼容端点可能挑剔，实测时留意。
- `New API` / `Sub2API` / `api2d` 是否稳定转发图片入参未逐一验证，目前依赖「失败退回纯文本」兜底。
- 图片按 small 规格取用，极端情况下小图上的文字可能模糊；如遇识别不准，可考虑按推文类型切换 `medium`。

## v2.2.1 — 2026-11-22 — 修复推理模型把输出额度全花在思考上导致零候选

**确定方案**

用户在 X 页面点 `AI回` 后只看到「正在打开回复框并生成」，随后提示「模型没有返回可用回复内容」，无草稿窗。控制台里候选数组为 `[]`（length 0）。

定位过程：`splitReplyText()` 对任何非空文本至少返回一条，`[]` 说明 `raw` 本身是空串，即 `extractModelText()` 没取到正文，问题不在清洗。取到用户实际响应体后确认：`content` 数组里只有 `type: "thinking"` 块，`stop_reason` 为 `max_tokens`，`usage.output_tokens` 450 且 `output_tokens_details.thinking_tokens` 也是 450，正文 0 token。`extractModelText()` 的 Anthropic 分支只挑 `type === "text"` 的块，过滤后返回空串，三轮全空。

第一轮尝试是提高额度（450 → 1200 → 1600）。实测仍被吃光，`thinking_tokens` 直接变成 1600。这说明该模型的思考会一直想到撞上限，加额度只是换一个更大的上限给它想，方向错了。

查 [DeepSeek 思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode.md) 后确认两点：Anthropic 格式支持 `{"thinking": {"type": "enabled/disabled"}}`；思考模式**默认打开**，effort 默认 `high`。插件只生成几十个词的短评论，思考过程没有收益，因此方案定为「默认不干预，遇到占满再关」。

**实施细节**

- `background.js`
  - `tokenLimitForCount()`：单条 `180` → `800`，多条 `max(360, n × 150)` → `max(1600, n × 500)`。`max_tokens` 是上限不是固定消耗，调高对普通模型不增加实际用量，保留是为了让 Claude 这类确实需要思考的模型有空间。
  - 新增 `isThinkingExhausted(data)`：判定 `content[]` 里只有 `thinking` 块、没有非空 `text` 块。
  - 新增 `describeNoTextResponse(data)`：按渠道给出具体原因，覆盖 Anthropic 只有 thinking 块、Responses 只有 reasoning 项、Chat Completions 正文为空但带 `reasoning_content` 三种情况；都对不上时带出响应顶层字段名。
  - 新增 `requireModelText(data)`：取不到正文时抛上述原因，替代原先的空字符串返回。四个 `request*()` 统一接入。
  - `requestAnthropic()` 重构：抽出 `send(body)` 复用请求逻辑。首次请求不带 `thinking` 字段，响应判定为思考占满时补 `thinking: { type: "disabled" }` 重试一次。端点若不接受该字段，重试仍失败，报错回落到 `describeNoTextResponse()`。
  - 只对 `anthropic` 渠道做自动关闭。Chat Completions 与 Responses 渠道的同类问题先只给明确报错，不擅自改请求体，避免中转站拒绝未知字段。
- `content.css` / `content.js`
  - `.akiii-toast-error` 圆角 `999px` → `18px`，加 `line-height: 1.5` 与 `word-break: break-word`。新增的错误文案有 40 字以上，胶囊圆角会把多行文字两侧裁掉。
  - `toast()` 中 error 类型显示时长 `3.2s` → `6s`，普通提示维持 `3.2s`。
- `tests/background.test.mjs`
  - 新增 5 条：只有 thinking 块时报思考占满、关思考重试后拿到正文、3 条候选的 `max_tokens` ≥ 1600、Chat 渠道 `reasoning_content` 提示、Responses 渠道只有 reasoning 项提示。
- `docs/使用说明书.md`、`docs/开发概要说明书.md`
  - 同步 `max_tokens` 数值、思考占满的处理规则、常见提示表新增三条。
- `XReplyHelper.zip`
  - 已重打，14 个条目。本次环境无 `pwsh`，改用 `zip -X -9` 按 `pack.ps1` 的同一白名单打包（7 个源文件 + 顶层无数字 `.txt` + `img/` 排除 `options_bg<数字>.png`）。

**同一轮补修**

排查中连带发现三处会让「点了没反应」更糟的问题，一并处理：

- `background.js`
  - 新增 `fetchWithTimeout()`，默认 60 秒上限，超时用 `AbortController` 中断并提示「接口 N 秒内没有响应」，四个 `request*()` 全部改走它。原先 `fetch` 无任何超时，接口挂住时按钮停在「生成中」、`STATE.activeRequest` 不释放，只能刷新页面。
- `content.js`
  - `runForArticle()` 去掉 `Promise.all([waitForTextbox(8500), 请求])`。改成先 `const editorPromise` / `const repliesPromise` 分别发起，`await editorPromise` 失败即抛错并对 `repliesPromise` 挂 `.catch(() => {})`。原写法下两条都成功才继续，「没找到回复框」永远等不到。
  - 新增 `isReplyComposer(editor)`，`injectComposerButton()` 注入前守卫：`aria-label` 含 `reply` / “回复”直接放行，否则要求所在弹窗内有原推节点。发帖框（`Add another post`、`Post`）不再注入 `AI填入`——该场景取不到上下文，点击只报「没有识别到要回复的推文」，按钮插入点按回复弹窗布局计算还会浮到 `Post` 上方。
  - 判据选「弹窗内有无原推」而不是「aria-label 是不是 Post」，是因为 X 改文案后纯靠字符串会把回复框误判成发帖框，直接导致回复弹窗里按钮消失。
- `tests/`
  - 新增 4 条：超时中断、正常返回不改响应、发帖框不注入、并行编排不等请求。
- `background.js`（第二轮，候选残片）
  - `stripNoise()` 增加首尾 JSON 包装清理：`["…`、`…["`、`…"]`。原先只清引号不清方括号，模型输出被截断时候选开头会留一个 `[`。规则要求“括号紧跟引号”才清，否则正文里正常的 `[Update]` 会被削掉左括号。
  - 新增 `extractQuotedStrings()`，`tryParseReplyJson()` 在其后兜底：JSON 解析全失败但整体仍以 `[` 或 `{` 开头时，只提取完整闭合的字符串项。原先截断的 JSON 会被 `splitReplyText()` 整段当成一条候选，157 词原文压到 108 词还带着包装字符。
- `tests/`
  - 再新增 2 条：截断 JSON 只取完整字符串、包装字符清理且不影响正常方括号正文。

**状态**

已交付。`node --test tests/*.test.mjs` 69/69 全绿。`manifest.json` 版本号仍为 `2.2`，本次只修行为不升版，发版时统一提升。

**遗留**

- `runForComposer()` 仍是 `await` 请求后才渲染草稿窗，编辑器未出现时不会提前失败；该路径的编辑器通常已由用户手动打开，暂未调整。
- 时间线主发帖框与「Add another post」都不注入 `AI填入`，这是有意为之，不是缺陷。

---

## v2.2 — 2026-05-27 — 草稿窗方形化 + 行内候选标签 + README 配图更新

**确定方案**

连续几轮实测后，草稿窗从偏宽的 600px 面板收敛为更紧凑的方形面板：桌面端以 490px 正方形为目标，小屏仍受 60dvh 限高约束。3 条候选保持全部可见，候选外层卡片底色去掉，只保留文本框本体、右侧复制 / 填入按钮和背景层次。

候选编号不再单独占一行，而是作为首行左侧的行内标签：标签贴在 textarea 左上角，左上与右下两个对角圆角和文本框一致；正文首行通过 `text-indent` 从标签右侧开始，后续换行回到正常左边界。

**实施细节**

- `content.css`
  - `.akiii-draft-panel` 改为 `490px` 方形上限，内边距统一为 `16px`
  - `.akiii-draft-head` 到第一条候选、候选之间、最后一条到底部的视觉留白统一为约 `16px`
  - `.akiii-draft-floating-label` 改为 `14px 0 14px 0` 圆角，匹配文本框圆角
  - `.akiii-draft-text` 改为 `height: clamp(108px, 13dvh, 112px)`，`padding: 10px 12px`，`text-indent: 70px`
  - 移动端保持 60dvh 限高，候选列表允许内部滚动，避免小屏溢出
- `manifest.json` / `content.js`
  - 版本号从 `2.1.4` 升到 `2.2`
  - 草稿窗标题继续读取 `chrome.runtime.getManifest().version`，fallback 更新为 `2.2`
- `README.md`
  - 当前版本与标题更新到 v2.2
  - 草稿窗截图替换为 `docs/readme_img/XReplyHelper_490.png`
  - 版本节点新增 v2.2 说明
- `docs/readme_img/XReplyHelper_490.png`
  - 使用本次 490px 方形草稿窗预览图，来源为 `C:\tmp\akiii-draft-490-balanced-preview.png`

**状态**

已交付。`node --test tests/*.test.mjs` 55/55 全绿；`XReplyHelper.zip` 在 push 前已由 `bash pack.sh` 重打。

---

## v2.1.4 — 2026-05-19 — hero 区作者超链接去样式 + 背景图替换收尾 + section-title 图标 lucide 化 + 修复 API Key 泄露事故

**确定方案**

v2.1.1 把作者署名升级成「强子手记 @iBigQiang & Akiii @Guomin184935」并给两个名字加了 X 主页超链接。但 `<a>` 在 options 玻璃拟态背景下默认是浏览器蓝 + 下划线，跟周围深青/白文字割裂感强。本次去掉两个超链接的视觉效果但保留 `href` 可点。同时收尾用户已经在做的视觉调整：背景图从 `img/akiii_bg.jpg` 换成 `img/options_bg.png`（强哥拍的新底图），并把暗化叠加层的 alpha 从 .70/.92 调到 .20/.4，让新背景图更显出来。

设置页 3 个 section-title 左侧的占位图标本来用的是 Unicode 字符 `✎` / `⌁` / `Aa`：`⌁`（电流符号）在多数字体里渲染成 tofu，`Aa` 跟「回复设置（参数面板）」语义对不上。本次替换成 lucide 风格的 inline SVG：`square-pen` / `plug` / `sliders-horizontal`，currentColor 继承青色高亮，扩展无需联网。

另外修复一个**严重安全事故**：GitGuardian 检出本仓库 v2.1.0 / v2.1.3 提交的 `docs/开发及迭代方案调研报告/迭代需求1.md` 第 14 行硬编码了一把真实 DeepSeek API Key（具体值在邮件正文中，本文档内不再复述），随 push 被发布到公网。问题根因：用户当时把命令行启动 Claude Code 用的 ANTHROPIC_AUTH_TOKEN 配置示例（含真实 Key）原样粘贴到迭代需求 markdown 里作为「自定义协议」示例，没意识到该目录会随 commit 进入公网仓库。本次做四件事彻底闭环：当前工作树脱敏、`.gitignore` 永久排除整个 `docs/开发及迭代方案调研报告/`、`git rm -r --cached` 让 git 不再追踪、`git filter-repo` 重写所有历史 commit 抹掉该目录、force push 覆盖远端。

**实施细节**

- `options.html`
  - `<style>` 段新增 `.author a` / `.author a:visited` / `.author a:hover` / `.author a:focus`：`color: inherit; text-decoration: none;` + hover 时 `opacity: .85` 给一点反馈
  - **只动 hero 区作者那一行**（用户明确要求），footer 的「设计与开发」链接保持现状
  - 用户已做的背景图替换 / 暗化层调淡保留：`img/akiii_bg.jpg` → `img/options_bg.png`，渐变 alpha `.70/.92` → `.20/.4`
  - 3 个 `.section-title .icon` 占位字符替换为 inline SVG：
    - 「回复内容（可编辑）」 `✎` → lucide `square-pen`（方框 + 笔），更精准表达「可编辑文档」语义
    - 「API 设置」 `⌁` → lucide `plug`（插头），表达「接口/连接器」，避开 `⌁` 在多数字体下 tofu 的问题
    - 「回复设置」 `Aa` → lucide `sliders-horizontal`（三条横向滑块），表达「参数面板」
  - `<style>` 段新增 `.section-title .icon svg { width: 14px; height: 14px; display: block; }`，控制 SVG 在 24×24 玻璃方块容器内的尺寸；外层容器、底色渐变、青色 currentColor 保持不变
- `content.css`
  - 用户已做的草稿窗背景图替换 / 暗化层调淡保留：`img/akiii_bg.jpg` → `img/options_bg.png`，alpha `.62/.88` → `.2/.4`
- `manifest.json`
  - v2.1.3 → v2.1.4
  - 用户已做的 `web_accessible_resources` 同步更新（删 `akiii_bg.jpg` 加 `options_bg.png`）保留
- `README.md`
  - 用户已做的署名升级 + 文件结构里背景图重命名保留
- 图片资源
  - `img/akiii_bg.jpg` 删除（被 `options_bg.png` 替代）
  - `img/miku_bg.svg` 删除（v2.0 起从未在任何代码里被引用，仅出现在 manifest 的 web_accessible_resources 和 README 文件结构里；本次顺手清理三处冗余）
  - `img/options_bg.png` 新增（已纳入打包）
  - `img/options_bg2.png` 保持 untracked 本地备份状态，不进仓库也不进 zip
- `pack.ps1`
  - img/ 打包逻辑加白名单：`options_bg<数字>.png` 模式的备选图不进 zip（跟现有 `.txt` 白名单"含数字=备份"风格一致）
- `manifest.json` / `README.md`
  - 跟着 `miku_bg.svg` 删除，从 `web_accessible_resources` 和 README 文件结构里同步移除引用
- `XReplyHelper.zip` 由 `bash pack.sh` 重打（3530 KB）
- **API Key 泄露事故修复**
  - `docs/开发及迭代方案调研报告/迭代需求1.md:14` 真实 Key 脱敏为 `sk-******************`
  - `.gitignore` 加规则：
    - `docs/开发及迭代方案调研报告/`（整个目录从此不进仓库；附三行注释说明历史教训）
    - 防御性规则：`*.env` / `.env.*` / `secrets.*` / `*.secret` / `*.key` / `*.pem` / `*credentials*` / `*api_key*` / `*apikey*`
  - `git rm -r --cached docs/开发及迭代方案调研报告/` —— 让 git 不再追踪这 6 个 markdown，本地文件保留（用户的迭代调研草稿，本地有用）
  - `git filter-repo --path "docs/开发及迭代方案调研报告/" --invert-paths` 重写所有历史 commit，抹掉该目录在 17 个 commit 中的所有版本；所有 commit SHA 改变
  - `git push --force-with-lease origin main` 把清理后的历史推到 GitHub，覆盖远端被泄露的版本

**状态**

代码已交付。`node --test tests/*.test.mjs` 41/41 全绿（本次只改 CSS / HTML 图标节点 / 版本号 / 文档，未触及任何被测代码路径）。Chrome 实测项：装载新 zip → 打开 options → hero 区作者那一行的「强子手记」「Akiii」应跟普通文字一样无下划线无蓝色（鼠标 hover 微微变淡）；新背景图应正常显示；3 个 section-title 左侧应能看到清晰的 lucide 线条图标（青色，宽高 14px）；footer 的链接仍是浏览器默认样式（不在本次范围）。

**用户必须手动跟进**：到 https://platform.deepseek.com 撤销已泄露的 Key（具体值在 GitGuardian 邮件中）。即使 GitHub 历史已彻底重写，第三方爬虫和搜索引擎缓存可能已抓取该 Key 副本，仅靠重写历史不能阻止他人盗用。撤销动作只能在 DeepSeek 平台完成，扩展和仓库都帮不上忙。

---

## v2.1.3 — 2026-05-19 — Base URL 智能自动补全归一化（学习 Cherry Studio）

**确定方案**

v2.1.0 引入的 8 渠道接口对用户输入粒度敏感：OpenAI 类必须填到 `/v1`、Anthropic 必须填到根域名、Gemini 必须填到 `/v1beta`，填错粒度就会拼出错误 URL（双 `/v1` 或缺 `/v1`）。本次参考 [Cherry Studio 服务商配置](https://docs.cherry-ai.com/pre-basic/settings/providers) 的兼容方案，做"用户填啥粒度都能拼对"的归一化升级。子代理联网核对了 6 个官方 endpoint 路径与 Cherry Studio 的 `#` 终止符规则，详细方案见 `docs/开发及迭代方案调研报告/2026-05-19-v2.1.3-Base-URL-自动补全归一化.md`。

**比 Cherry Studio 多走一步**：Cherry Studio 不识别"已含 /v1"，靠用户用 `#` 显式声明；本扩展面向 X 用户，让他们记 `#` 太重，所以默认就**智能识别**根域名 / `/v1` / `/v1/` / 完整 endpoint，`#` 仅作为「保留逃生舱」用于走 Azure 风格特殊路径。

**实施细节**

- `options.js`
  - 重写 `buildEndpointPreview`：所有依赖（`PATH_SPEC` / `escapeRe` / 归一化算法）都内联到函数闭包内，保证 `tests/endpoint-preview.test.mjs` 的 `new Function` 抽函数测试仍可用
  - `PROVIDER_BASE_HINTS` 8 条全部升级文案，告知用户可填根域名或带 /v1，提示 `#` 终止符
- `background.js`
  - 新增顶层 `PROVIDER_PATH_SPEC` + `escapeRegex` + `buildFinalEndpoint`，与 `options.js` 的 `buildEndpointPreview` 同款逻辑
  - 删除 v2.1.0 残留的死代码 `buildRequestUrl`
  - 重构 `callModel`：custom 渠道保持完全透传（仅去掉末尾 `/` 或 `#`），其他渠道用 `buildFinalEndpoint` 计算 `requestUrl` 后传给请求函数
  - 重构 `requestOpenAIChat` / `requestOpenAIResponses` / `requestGemini` / `requestAnthropic`：均改为接收必填的 `requestUrl` 参数，不再内部拼接路径；删除 `urlOverride` 二义性
- `options.html`
  - Base URL 输入框下方 fallback `apiBaseHint` 文案升级为"支持填根域名或带 /v1，自动补全；末尾加 # 强制完整 URL"
- `tests/endpoint-preview.test.mjs` 新增 10 条用例
  - openai_chat 根域名自动补、完整 endpoint 透传（含大小写）
  - openai_responses 根域名补全
  - anthropic 带 /v1 不重复、完整 endpoint 透传
  - gemini 根域名补全、完整 endpoint（含 model）透传
  - newapi / sub2api 根域名补全
  - `#` 终止符跨 provider 透传（含 Azure 风格路径）
  - `/v1$` 边界匹配不误判 `/v1beta`
  - base 为空给占位
- `tests/background.test.mjs` 新增 5 条用例覆盖实际 fetch URL
  - anthropic 填根域名 / 填带 /v1 各自正确
  - openai_chat 填根域名自动补 /v1/chat/completions
  - `#` 终止符强制透传 Azure 风格路径
  - gemini 填根域名自动补 /v1beta/models/{model}:generateContent
- `manifest.json` v2.1.2 → v2.1.3，description 补「Base URL 智能自动补全（根域名 / 带 /v1 / 完整 endpoint / # 终止符 都能识别）」
- `XReplyHelper.zip` 由 `bash pack.sh` 重打
- **不动**：内容脚本、CSS、UI 布局、`PROVIDER_DEFAULTS` 默认值（保持向后兼容现有用户配置）
- 不触发 Impeccable 全审（后端逻辑 + 文案微调），不跑 /btw（属"补强已有特性的兼容性"）

**状态**

代码与测试已交付。`node --test tests/*.test.mjs` 41/41 全绿（原 25 + 新 16）。Chrome 实测项：装载新 zip → options 页 → 试三种粒度（根域名 / 带 /v1 / 带 /v1/）切换各渠道、实时预览 URL 应一致；点 AI回 实际生成应成功；故意配错的 base 仍能报"Base URL 可能填成了首页"。

---

## v2.1.2 — 2026-05-19 — API Key 输入框加密码可见性切换（小眼睛）

**确定方案**

用户配置 API Key 经常因为粘贴时多了空格、漏了字符或 fk/sk 前缀混淆而保存了一个「看不见的错」。`<input id="apiKey" type="password">` 永远以圆点显示，没法快速核对粘进去的内容。本次给 API Key 输入框右端加一个小眼睛切换按钮，点击在 `password` ↔ `text` 之间切换，**默认仍是 `password`**，不退化安全默认。详细方案见 `docs/开发及迭代方案调研报告/2026-05-19-v2.1.2-API-Key-可见性切换.md`。

**实施细节**

- `options.html`
  - `<style>` 段末尾新增 `.input-with-toggle` / `.visibility-toggle` 规则：wrapper 相对定位、按钮绝对定位到右内侧 6px，圆角 10px、透明背景、hover 变青蓝、`focus-visible` 给青色 outline 环
  - `.input-with-toggle > input` 单独加 `padding-right: 44px`（不动全局 input 样式，不影响其他字段）
  - 用 `aria-pressed="true"` 切两个 inline SVG（`.eye-open` / `.eye-off`）的 display，避免外部图标资源
  - API Key input 包到 `<div class="input-with-toggle">` 内，紧跟一个 `<button id="apiKeyToggle" type="button" aria-pressed="false" aria-label="显示 API Key">`，两个 SVG（open-eye / eye-off）作为子元素
- `options.js`
  - 末尾追加 `$("apiKeyToggle").addEventListener("click", ...)`：判断当前 input.type，切到 password / text，同步 `aria-pressed` 与 `aria-label`
- `tests/options-html.test.mjs`（**新增**，5 条用例）
  - 断言 `<input id="apiKey">` 默认 `type="password"` + `autocomplete="off"`
  - 断言 wrapper 结构包住 input 与切换按钮
  - 断言切换按钮初始 a11y 属性：`type="button"` / `aria-pressed="false"` / `aria-label="显示 API Key"`
  - 断言 CSS 段有相关规则且按 `aria-pressed` 切 SVG
  - 断言 options.js 绑定了 click 事件并切 type / aria-pressed / aria-label
- `manifest.json` v2.1.1 → v2.1.2，description 末尾补「API Key 输入框支持密码可见性切换」
- `XReplyHelper.zip` 由 `bash pack.sh` 重打
- **不动** background.js / content.js / content.css / 任何 v2.1.0 引入的 provider 逻辑；CLAUDE.md 不动（不涉及新规则）
- 不触发 Impeccable 全审（局部交互增强，未改页面结构 / 信息架构 / 配色 / 排版），不跑 /btw（补丁级）

**状态**

代码与测试已交付。`node --test tests/*.test.mjs` 25/25 全绿（原 20 + 新 5）。Chrome 实测项：装载新 zip → 打开 options → 点击 API Key 右端小眼睛，确认在「圆点」与「明文」之间切换、aria-label 变化、键盘 Tab 顺序正常，并目视确认按钮跟玻璃拟态风协调、hover/focus 状态友好。

---

## v2.1.1 — 2026-05-19 — v2.1.0 收尾微调（作者署名统一 + provider 文案 + Base URL 上移）

**确定方案**

v2.1.0 commit (`0fba933`) 在 push 之后又陆续手动调了 4 个文件：作者署名口径升级、`provider` 选项加「兼容」前缀、Base URL 输入框位置上移、`迭代需求1.md` 末尾误留空 `<a>`。这些散落改动需要收拢成一个补丁版本走完 `/ship`，避免 zip 与代码版本号脱节。同时把 `CLAUDE.md`「作者署名（固定）」段落同步到最新口径，杜绝未来被回退。详细方案见 `docs/开发及迭代方案调研报告/2026-05-19-v2.1.1-收尾微调.md`。

**实施细节**

- `content.js` 543 行草稿窗副标题：`作者：强子手记 & Akiii` → `作者：强子手记 @iBigQiang & Akiii @Guomin184935`（补回 @ handle）
- `README.md` 来源与致谢段：`@iBigQiang，@Guomin184935` → `强子手记 @iBigQiang & Akiii @Guomin184935`
- `options.html` hero（298 行）保持 v2.1.0 push 后的「带 X 链接的强子手记 + Akiii」版本，无需再改
- `options.html` footer（399 行）保持「由 强子手记 & Akiii 设计与开发」精简别名版（不加 @ handle —— 跟「作者」语义不同）
- `options.html` provider select 三项保留「兼容 OpenAI-Chat / 兼容 OpenAI-Response / 兼容 Anthropic」前缀，表达"用同协议接入同类接口"的兼容含义
- `options.html` Base URL 输入框 + 预览节点保持在 API Key **之前**（v2.1.0 push 后的位置），让用户先确定 endpoint 再贴 Key
- `docs/.../迭代需求1.md` 末尾删除 `<a href="" target="_blank"></a>` 与多余空行
- `CLAUDE.md`「作者署名（固定）」段落重写：明确三处统一口径，并补一句 footer 与「作者」语义不同
- `manifest.json` v2.1.0 → v2.1.1（description 仍是 v2.1 的 8 渠道说明，无需重写）
- `XReplyHelper.zip` 由 `bash pack.sh` 重打
- 不动 `background.js` / `options.js` / `content.css` / 任何测试代码（已验证 `tests/` 无作者署名字符串断言）
- 不触发 Impeccable 多子技能审查（本次只是文案 + 位置微调，无新页面、无新交互），不跑 /btw（补丁级，未达"中大型迭代"门槛）

**状态**

代码与文档已交付。`node --test tests/*.test.mjs` 预期仍 20/20 全绿（本次未改任何被测代码路径）。Chrome 实测项降级为：装载新 zip 后打开 options 与草稿窗，目视确认三处作者署名口径一致，并验证 v2.1.0 已经通过的 8 渠道生成 / Base URL 实时预览仍正常。

---

## v2.1.0 — 2026-05-19 — 多渠道接口扩展 + Base URL 预览 + 配置缓存 + UI 微调

**确定方案**

v2.0 只支持 3 档接口（`openai_responses` / `chat` / `api2d`），无法直接接入 Gemini、Anthropic、New API、Sub2API 等主流网关；同时回复弹窗的「AI填入」按钮文字左偏、草稿窗右上角 × 偏上偏左，是 v2.0 上线后用户实测发现的视觉 bug。本次按 `docs/开发及迭代方案调研报告/2026-05-19-迭代需求1-多渠道接口扩展.md` 把接口扩到 **8 档** 并增加「每个渠道独立配置缓存 + 输入即变的 Base URL 预览」，同时修掉 3 处 UI bug。

**实施细节**

- `background.js`
  - 新增常量 `PROVIDER_IDS` / `PROVIDER_DEFAULTS`：8 个 provider 的默认 Base URL / 默认模型/ 子协议
  - 新增 `migrateSettings`：老用户 `provider: "chat"` → `openai_chat`；老顶层 `apiKey/model/apiBase/api2dBase` 自动回填到 `providerProfiles`
  - 新增 `getActiveProfile`：根据 `effective provider` 读对应 profile，顶层字段作为兜底
  - 重命名 `requestChatCompletions` → `requestOpenAIChat`，新增 `requestOpenAIResponses` / `requestGemini` / `requestAnthropic` 三条独立路径
  - `callModel` 改 8-way switch；`custom` 走子协议（`openai_chat` / `openai_responses` / `anthropic` / `gemini`），把用户填的完整 endpoint 直接作为 URL 透传
  - `extractModelText` 增加 Anthropic（`content[].text`）和 Gemini（`candidates[0].content.parts[].text`）两个分支
  - `explainApiError` 为 Anthropic / Gemini 加上 401 中文解释
  - `getEffectiveProvider`：`fk` 开头 Key 仍只切 api2d，**不会**误识别 sub2api / newapi
- `options.html`
  - 接口类型 select 扩到 8 项（OpenAI-Chat / OpenAI-Response / Gemini / Anthropic / New API / Sub2API / api2d / 自定义）
  - 删除 v2.0 的「API2D Base URL」独立输入框 — 切换到 api2d 时 Base URL 自动从 profile 缓存回填
  - 新增 `customProtocolRow`：选择「自定义」时显示子协议下拉（OpenAI-Chat / OpenAI-Response / Anthropic / Gemini，默认 OpenAI-Chat）
  - Base URL 输入框下方新增 `apiBasePreview` 节点（灰度等宽字体），实时显示完整 endpoint
  - Base URL hint 文案按 provider 动态变（`PROVIDER_BASE_HINTS`）
- `options.js`
  - 新增 `providerProfiles` 内存模型 + `chrome.storage.local` 双写：每个 provider 一份 `{ apiKey, model, apiBase, customProtocol? }`
  - 新增 `buildEndpointPreview`：与 `background.js` 的 `buildRequestUrl` 一一对应；任意 `provider / model / apiBase / customProtocol` 输入即触发预览刷新
  - `onProviderChange`：切换 provider 前先把当前表单写回旧 profile，再从新 profile 读字段回填表单
  - `save`：把当前表单写回 `providerProfiles[currentProvider]`，再把当前 profile 的字段同步到顶层 `apiKey/model/apiBase`（兼容 background 的兜底读法），最后整对象 `storage.local.set`
  - `fk` 开头 Key 在 save 时自动切到 api2d profile 并切换激活 provider，与 v2.0 保持一致
- `content.css`
  - `.akiii-ai-button`：新增 `display: inline-flex; align-items: center; justify-content: center; text-align: center;` — 修复评论框/弹窗内 AI 填入按钮文字左偏
  - `.akiii-draft-close`：改成 `display: inline-grid; place-items: center; padding: 0;` — 修复草稿窗右上角 × 偏上偏左
- `tests/`
  - `background.test.mjs`：在已有 2 条用例外，新增 4 条用例覆盖 **anthropic 走 `/v1/messages` + `x-api-key` 头 + 解析 `content[].text`**、**gemini 走 `/models/{model}:generateContent` + `x-goog-api-key` 头**、**newapi 路由到 OpenAI Chat**、**老 `provider: "chat"` 自动迁移到 `openai_chat`**
  - `content-css.test.mjs`：新增 2 条断言覆盖 AI 按钮 flex 居中、× 按钮 grid 居中
  - 新增 `tests/endpoint-preview.test.mjs`：8 个用例覆盖 `buildEndpointPreview` 各 provider 的 URL 拼接、末尾 `/` normalize、空 model 占位符、custom 透传
- `manifest.json` 升 v2.1.0，描述补充 8 个渠道说明
- `XReplyHelper.zip` 由 `bash pack.sh` 重打

**状态**

代码与测试已交付。`node --test tests/*.test.mjs` 20/20 全绿（含新增 14 条）。Chrome 实测验证清单（按 `CLAUDE.md`「改动前的强制验证清单」）由用户在装载新版本扩展后跑一遍：8 个渠道任选 2-3 个跑通生成、Base URL 预览实时更新、provider 切换时配置自动回填、3 处 UI bug 截图复测全消、HTML 响应仍能正确报"Base URL 可能填成了首页"。

---

## v2.0.2 — 2025-05-18 — Ship 打包流程固化

**确定方案**

迭代过程中发现：远端仓库根目录有一份 `XReplyHelper.zip` 供普通用户直接下载使用，但项目没有任何"每次迭代后必须重打 zip"的强约束，容易把"代码已更新、zip 还是旧的"这种 bug 带到生产。把打包步骤固化进 `CLAUDE.md` 的 /ship 收尾流程，并落地一个 `pack.sh` 脚本，让每次迭代结束 push 前都重新生成 zip。

**实施细节**

- 新增 `pack.sh`（项目根）— 一键打包：`manifest.json` + 4 个 js/css/html + `img/` + `README.md` + `禁用词.txt` + `额外提示词.txt`，明确**不**打入 `CLAUDE.md` / `docs/` / `tasks/` / `tests/` / `.gitignore` / `pack.sh` / 私有灵感库（`额外提示词1.txt` / `额外提示词2.txt`）
- `CLAUDE.md` 新增「/ship 收尾流程（本项目专用）」小节，明确"push 前必跑 `bash pack.sh`，把新 zip 一起提交，老 zip 必须覆盖"
- `CLAUDE.md`「常用命令」加入 `bash pack.sh`
- `CLAUDE.md`「改动前的强制验证清单」末尾追加一条"重打 zip 并随 commit 提交"
- 本次执行 `bash pack.sh` 生成新 zip 覆盖远端旧 zip

**状态**

已交付。新 zip 与文档一起进入新 commit。

---

## v2.0.1 — 2025-05-18 — 文档底座补齐

**确定方案**

按 `~/.claude/CLAUDE.md` 全局规则要求，每次重启项目都要 `/newup`，每次迭代都要更新 `docs/DEVLOG.md`。v2.0.0 落地时只留了 `README.md`，没有 `CLAUDE.md` 也没有 `DEVLOG.md`，后续迭代的规则跑不通。本次只做文档底座，不动任何代码。

**实施细节**

- 新增 `CLAUDE.md`（项目根）— 项目专属规则、关键运行机制、避坑、命令、验证清单
- 新增 `docs/DEVLOG.md` — 开发日志，回填 v2.0.0 已知状态
- 新增 `docs/开发及迭代方案调研报告/2025-05-18-文档底座补齐.md` — 本次方案文档
- 新增 `tasks/todo.md` — 本次迭代任务清单 + 复盘
- 不动 `background.js` / `content.js` / `content.css` / `options.*` / `manifest.json` / `tests/`
- 不改 `README.md`，让"终端用户视角"与"AI/工程师视角"两份文档各司其职

**状态**

已交付。`node --test tests/*.test.mjs` 全绿，6 个用例全过（仅文档变动，无误伤面）。

---

## v2.0.0 — 2025-05-12 — 三条候选 + 玻璃拟态草稿窗（回填）

**确定方案**

v1.x 每次只生成 1 条回复直接填入，用户经常觉得"不够顺手就只能再点一次重新生成"。v2.0 改成一次生成 3 条候选，先进入可编辑草稿窗，用户挑一条改满意再点对应的「填入 X」。同时修一批 v1.x 的痛点：HTML 响应被错认成正常回复、API2D Key 配错 provider、X 编辑器填入后状态错乱。

**实施细节**

- `background.js`
  - 新增 `generateReplies(payload, count=3)`，最多 3 轮重试，每轮把"上一次输出不合格"追加到 instructions
  - 新增 `parseReplyCandidates` / `tryParseReplyJson` / `splitReplyText` / `cleanReplyCandidates`，先按 JSON 数组解析，再回退到编号/项目符号文本
  - `readJsonResponse` 检测 `text/html` 或开头 `<` 时直接抛"接口返回 HTML，Base URL 可能填成了首页"，**不再**退化成固定兜底回复
  - `getEffectiveProvider` 识别 `fk` 开头 Key 自动切 API2D；`explainApiError` 把 401 翻译成人话
  - 候选清洗：`dedupeRepeatedText` 压缩同一句复制 2/3/4 遍、`maybeRepairMojibake` 修 UTF-8 被当 Latin-1 读的乱码、`looksLikeBrokenText` 整条丢弃乱码
  - `requestResponses` 走 `/v1/responses`（OpenAI 官方新接口），`requestChatCompletions` 走 `/v1/chat/completions`（兼容/API2D）
- `content.js`
  - 新增 `showDraftPanel(replies, editor)` — 右下角玻璃拟态草稿窗，3 条候选独立 textarea + 复制 / 填入 X 按钮
  - 修 X 编辑器填入：移除 `selectNodeContents + 硬替换`（React/Draft 状态会错乱），改用 `tryPasteEvent`（构造 `DataTransfer + ClipboardEvent('paste')`）→ `tryInsertTextCommand`（`execCommand('insertText')`）→ 复制兜底
  - `getInsertTargets` 优先弹窗内 textbox，再退到调用者传入的 editor；`getBestTextbox` 优先 active dialog 内的活动元素
  - `extractTweetFromArticle` / `extractTweetFromDialog` 双路抽取，dialog 抽取去掉按钮/textarea/工具栏
  - `runWithButton` + `STATE.activeRequest` 单飞控制，防止用户连点
- `options.html` / `options.js`
  - 升级玻璃拟态 + 初音风渐变 + 强哥（`Qiangge.jpg`）作为 hero 头像
  - 字段集中：provider / apiKey / model / apiBase / api2dBase / defaultLanguage / maxChineseChars / maxEnglishWords / projectHandle / bannedWords / customPrompt / debugMode
  - `normalizeProviderByKey` 在保存时识别 `fk` 开头 Key 并自动切 API2D
  - `defaultStyle` 在 readForm 里强制写 `sharp`，对应 background 里唯一的 `STYLE_MAP`
- `manifest.json`
  - 改为 `manifest_version: 3`、`version: 2.0.0`
  - 点击 action 不再弹 popup，走 `chrome.action.onClicked` → `openOptionsPage`
  - `host_permissions` 保留 `https://*/*` + localhost，给兼容接口留口子
- `tests/`
  - `manifest.test.mjs` — 断言 `options_page === "options.html"` 且无 `default_popup`
  - `background.test.mjs` — `vm` 沙箱跑 `background.js`，断言 HTML 200 响应被识别为配置错误；断言 JSON 数组响应能产出 3 条清洗后候选
  - `content-js.test.mjs` — 静态结构检查 `getBestTextbox` 内的 dialog 优先级、`getInsertTargets` 的 targets 顺序
  - `content-css.test.mjs` — 静态检查 `.akiii-draft-panel` 等宽按钮变量、textarea `max-width: 500px`、grid `max-content`

**状态**

已交付。`README.md` 与 `manifest.json` 都标记为 v2.0.0。

---

## v1.x — 早期版本（信息缺失）

当时没有 DEVLOG 沉淀，代码里也没有版本变更说明。已知大致能力：一次生成一条回复直接填入；弹出式 popup 设置框；只有英文/中文一档默认风格。其余细节无法精确回填，保留此条目以备后续考古。
