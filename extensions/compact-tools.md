# compact-tools — 紧凑工具卡片 + 请求级工具聚合

把会话里的工具噪声压到最低：

- **聚合模式（默认）**：一次提问里的所有工具调用最终只留**一个汇总块**；执行期间只在最新一行上显示一句进度。
- **v1 模式**（`PI_COMPACT_TOOLS_AGGREGATE=0`）：一行一个工具，折叠=摘要一行，`Ctrl+O` 展开。

渲染与汇总**只影响 TUI**；对模型上下文的影响有且只有一处：本扩展注册了 7 个同名内置工具，而 pi 默认会
激活所有扩展注册的工具（未配置 `defaultTools` 时默认内置激活集只有 `read`/`bash`/`edit`/`write`），
因此 `grep`/`find`/`ls` 会被一并激活（≈ +2.2KB/请求，约 550–750 token，见 §8）。

除此之外上下文**零增量**：4 个共享工具的 `description`/`promptSnippet`/`promptGuidelines`/`parameters`
与内置逐字节相同（`execute` 原样返回内置结果同一引用），不新增工具、不增提示文本、不 `sendMessage`；
`compact-tools.group` 自定义条目不进 LLM 上下文。

| 项目 | 内容 |
| --- | --- |
| 文件 | `extensions/compact-tools.ts` |
| 说明文档 | 本文件 |
| 自测 | `node extensions/compact-tools.selftest.mjs`（24 例） |
| 生效方式 | `/reload`（或重启 pi） |
| 基线 | pi 0.85.1（升级后对照 §7 检查清单） |
| 执行逻辑 | 100% 委托内置工具实现（同一对象引用返回） |
| 上下文影响 | 仅激活 `grep`/`find`/`ls`（≈ +2.2KB/请求，约 550–750 token）；其余为 0，见 §8 |
| 聚合开关 | `PI_COMPACT_TOOLS_AGGREGATE=0` 退回 v1 |
| session 条目 | `compact-tools.group`（v2：`ids` 全量 + 首 5/末 15 项 `items`；TUI-only，不进 LLM 上下文） |
| 备份 | v1 原文留在 `compact-tools.ts.bak` |

目录里 `.md` / `.mjs` / `.bak` 都不会被加载：pi 只扫描 `extensions/*.ts`、`extensions/*.js`、
`extensions/<子目录>/index.ts|js` 或带 `pi` 字段的 `package.json`。

---

## 1. 效果

### 聚合模式（默认）

```
› 帮我把日志调用统一一下

● 先看看现有写法。
  ⏳ 处理中 3 个操作 · 最新：📖 读取 src/app.ts      ← 进行中只有这一行

● 已统一为 logger.info(...)，共改 4 处。

 📝 本次汇总（位于回答下方，持久保存、可 Ctrl+O 展开）
 🔧 本次 8 个操作：✏️ 修改 5 个文件 · 📖 读取 3 个文件 · 💻 执行 2 条命令 · 🔍 搜索 1 次
 📝 src/app.ts、log.ts、config.ts、index.ts、utils.ts 等 7 个文件
 ⚠️ 1 个操作失败：Command exited with code 1
```

`Ctrl+O`（keybinding id `app.tools.expand`）展开后逐项列出（超过 20 项时保留首 5 + 末 15，中间插一行省略标记）：

```
✓ 修改 src/app.ts（+12 / −4）
✓ 修改 log.ts
✗ 执行命令 npm test  Command exited with code 1
… 省略 5 项 …
✓ 修改 utils.ts
⚠️ 读取 src/index.ts  已中断
```

### 展开态的分段配色

展开明细里**只有「会改动文件的行」（`edit` / `write`）上分段颜色**，其余行保持单色：

| 片段 | 色键（dark 主题色值） | 出现行 |
| --- | --- | --- |
| 文件路径**末段**（`app.ts`） | `accent`（#8abeb7） | 改动文件且成功的行 |
| `+a`（新增行数） | `toolDiffAdded`（#b5bd68） | 同上（仅有 diff 统计时） |
| `−r`（删除行数） | `toolDiffRemoved`（#cc6666） | 同上 |
| `✓ 修改 ` 前缀、目录前缀（`src/`）、括号、` / ` | `toolOutput`（#808080） | 同上 |
| 整行（读取 / 查看 / 搜索 / 命令） | `toolOutput`（#808080） | **不上色** |
| 整行（失败 `✗` / 中断 `⚠️` / 省略 `…`） | `error` / `warning` / `muted` | **不拆色**（失败信号保持整行红） |

即：目录前缀仍是灰的，亮起来的只有文件名末段；`+a` 绿 与 `−r` 红就是「修改 / 删除」的体现
（删除以 `−r` 红色表示，**不检测 bash 的 `rm`**）。配色存在条目的 `Detail.segs` 里，
**`text` 字段完全不变**，所以 `pi -c` 恢复后颜色依旧。

> 分段配色自 **v0.1.2** 起生效。更早版本写入的汇总块条目（session 里没有 `segs` 字段）**仍按单色渲染**——
> 设计上不改写历史条目数据，因此也不需要任何迁移。想在旧块上看到颜色只能重发同一条更新，这是刻意的取舍。
> 「删除文件」同理：bash 的 `rm` 属于「执行命令」行，不上色；删除只以 `−r` 红色体现。

### v1 模式（`PI_COMPACT_TOOLS_AGGREGATE=0`）

```
read compact-tools.ts (offset=1)   ← 调用行
✓ 30 行                                                    ← 结果摘要（折叠态只有这一行）

$ npm run build
✓ done · 12 行
[截断]

edit src/app.ts (3 处)
+12 / −4
```

### 各工具摘要对照（v1 折叠态与聚合明细共用）

| 工具 | 调用行 | 结果摘要 |
| --- | --- | --- |
| read | `read <path> (offset=, limit=)` | `✓ N 行` / `✓ 图片` / `（空）` |
| bash | `$ <命令前 100 字> (timeout Ns)` | `✓ done · N 行` / `✗ Command exited with code N` / `[截断]` |
| write | `write <path> (N 行)` | `✓ 已写入` |
| edit | `edit <path> (N 处)` | `+新增 / −删除`（无 diff 时 `✓ 已应用`） |
| grep | `grep /pattern/ · <path> (glob)` | `✓ N 处匹配` / `无匹配` |
| find | `find <pattern> · <path>` | `✓ N 个文件` / `无结果` |
| ls | `ls <path>` | `✓ N 项` / `（空）` |

流式执行中显示 `运行中… / 读取中… / 搜索中…`。任何失败统一显示为红色 `✗ <错误最后一行>`。

---

## 2. 聚合模式

### 分组边界

一次用户请求 = 一次 `agent_start → agent_end`；模型中途的多次思考、多批工具调用都归入同一个块。
新的一次提问开始新的块（旧块保留在会话里）。纯聊天（0 个工具调用）不产生块、也不写 session 条目。

### 进行中

- 所有工具行都不显示；只有**最新一次工具调用那一行**显示一行进度：
  `⏳ 处理中 {本次已登记的操作数} 个操作 · 最新：{图标} {动词} {目标}`
- 目标：文件类是文件名，目录类是目录名，命令类是命令前 40 字，搜索类是 pattern。
- 进度行指向**最新一个仍在运行的项**（并行调用时不被旧项占住）；全部跑完（等模型收尾）→ 指向最后一项。
- 运行期新出现的工具行**从不显示**（直接零高度），所以不会有「先闪一下 v1 行再变进度行」。
  若一行到请求结束都没被登记（被其它扩展在 `tool_call` 阶段拦下、或执行前被中断），
  它会在请求结束时**恢复成 v1 紧凑行**，不会静默消失（见坑 8）。

### 请求结束

写入一条 `compact-tools.group` session 条目（`pi.appendEntry`，**不进 LLM 上下文**），
工具行全部消失，块追加在**该请求最后一个回答的下方**。块最多 3 行：

| 行 | 内容 | 出现条件 |
| --- | --- | --- |
| 1 | `🔧 本次 N 个操作：` + 分类计数 | 总是（只列出现过的类别，顺序：修改 → 读取 → 查看 → 命令 → 搜索） |
| 2 | `📝 <被修改的文件名>` | 有修改类操作时；去重、最多 5 个、超出追加 `等 N 个文件`；**两个文件同名时改用相对路径** |
| 3 | `⚠️ N 个操作失败：<首条错误>` / `N 个操作中断` | 有失败或中断时 |

类别归属见上表。单次工具调用的请求同样折叠。`Ctrl+O` 展开明细：每项一行，含 `+a / −r`（edit）与错误首行；
明细上限 20 项，超出时保留**最早 5 项 + 最新 15 项**，中间显示 `… 省略 N 项 …`。
其中「会改动文件的行」（edit / write）会分段上色（文件名末段 + `+a`/`−r`），规则见 §1「展开态的分段配色」。

### 会话恢复

`session_start` 时读取历史 `compact-tools.group` 条目重建 `toolCallId → 组` 映射，因此 `pi -c` 恢复后：
历史请求各显示 **1 个汇总块**，对应工具行全部消失（无「幽灵行」）；块可 `Ctrl+O` 展开，明细来自条目数据、
不需要重新执行工具。条目兼容 `v: 1`（只存全量 `items`）与 `v: 2`（`ids` 全量 + `items` 首尾封顶）；
恢复时只消费 `lines/details/detailTotal/hasError` 与 toolCallId 列表，畸形数据（非法 id、未知 `cat`、
非字符串项）会被跳过而不是报错。

### 覆盖范围

只覆盖本扩展接管的 7 个内置工具。其它扩展注册的工具、`user_bash` 等保持原样显示，**也不计入汇总**
（无法控制它们的渲染）。

---

## 3. 可调项

| 想改什么 | 改哪里（文件顶部常量区） |
| --- | --- |
| 关闭聚合 | 环境变量 `PI_COMPACT_TOOLS_AGGREGATE=0` |
| 展开时最多显示多少行（v1 预览） | `EXPANDED_LIMIT = 30` |
| 汇总块最多列几个被修改文件名 | `MODIFIED_NAME_MAX = 5` |
| 明细保留的最早 / 最新项数 | `DETAIL_HEAD = 5` / `DETAIL_TAIL = 15`（`DETAIL_MAX = 20`，同时也是条目 `items` 上限） |
| 进度行里命令/标签长度 | `LABEL_MAX = 40` |
| 「修改」明细行的分段配色 | `SEG_FILE_COLOR = "accent"` / `SEG_ADD_COLOR = "toolDiffAdded"` / `SEG_DEL_COLOR = "toolDiffRemoved"` |
| 汇总/进度文案与类别归属 | `CAT_OF` / `CAT_ORDER` / `CAT_ICON` / `CAT_VERB` / `CAT_LABEL` + `buildSummary()` |
| session 条目类型 | `ENTRY_TYPE`（**改动会使旧会话的汇总块失效**） |
| 只保留某个工具的内置渲染 | 删掉该工具的 `...makeRenderers("<tool>")`，改为 `renderShell: "default"` |

主题键（`theme.fg(name, text)`）：`toolTitle` `accent` `dim` `muted` `success` `error` `warning` `toolOutput` `toolDiffAdded` `toolDiffRemoved` `toolDiffContext`；
背景键（`theme.bg`）：`toolPendingBg` `toolSuccessBg` `toolErrorBg`。可用键以 `docs/themes.md` 为准。

> 删掉渲染器即可退回内置样式：pi 会按 slot 继承内置渲染器（`withBuiltInRenderers()`），
> 但**聚合会失效**（内置渲染器不会隐藏自己的行）。

---

## 4. 维护须知：十个坑

改这个文件前请先读完这一节。每条都是「看起来能跑、实际会悄悄丢功能」的类型。

### 坑 1：必须 spread `createXxxToolDefinition()`，不能只用 `createXxxTool()`

```ts
// ❌ 只拿 description/parameters，其它元数据全丢
const t = createReadTool(cwd);
pi.registerTool({ name: "read", description: t.description, parameters: t.parameters, ... });

// ✅ 定义对象整体 spread
const def = createReadToolDefinition(cwd);
pi.registerTool({ ...def, renderShell: "self", async execute(...) {}, ...makeRenderers("read") });
```

`promptSnippet` / `promptGuidelines` / `renderShell` / `prepareArguments` / `constrainedSampling`
**不会**从被覆盖的内置工具继承（`docs/extensions.md` 明确写了）。症状：

- 系统提示 `Available tools:` 里这 7 个工具消失（只剩 `(none)`）
- `Guidelines:` 里 `Use read to examine files instead of cat or sed.`、edit 的 4 条
  `edits[].oldText` 匹配规则、`Use write only for new files or complete rewrites.` 全部消失

### 坑 2：edit 的 `prepareArguments` 不能丢

`createEditToolDefinition()` 自带兼容层：`edits` 被发成 **JSON 字符串**（Opus 4.6 / GLM-5.1 会这样）、
发成**单个对象**、以及旧会话里的**顶层 `oldText`+`newText`** 都会被折成 `edits[]`。用 spread 就自动保留。

### 坑 3：settings 要透传

```ts
const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() });
createBashToolDefinition(cwd, {
  commandPrefix: settings.getShellCommandPrefix(),
  shellPath: settings.getShellPath(),
});
```

丢了这段 → `settings.json` 的 `shellPath` / `shellCommandPrefix` 与图片自动缩放**静默失效**。
缓存键是 `cwd + 项目信任`（项目 `.pi/settings.json` 只在受信任时读取，必须把
`ctx.isProjectTrusted()` 算进去）。

### 坑 4：失败要用 `context.isError` 判定，不要猜文本

内置工具的错误是 **throw** 出来的，由 agent-loop 包成
`createErrorToolResult(error.message)` + `isError: true`：

- 错误文本**不以** `error` 开头（是 `ENOENT: ...` / `EACCES: ...`）
- bash 是 `Command exited with code 7`，**不是** `exit code: 7`
- 其它：`Command timed out after N seconds`、`Command aborted`、`Operation aborted`

只用文本匹配的后果：失败命令显示绿色 `✓ done`，写文件失败显示 `✓ 已写入`。

### 坑 5：无结果不是「1 条结果」，截断提示要精准剔除

| 工具 | 无结果时的文本 | 按行计数的错误结果 |
| --- | --- | --- |
| grep | `No matches found` | `✓ 1 处匹配` |
| find | `No files found matching pattern` | `✓ 1 个文件` |
| ls | `(empty directory)` | `✓ 1 项` |

read 会在结尾追加提示行，统计行数时必须剔除。但要**只匹配内置 read 真正会追加的两类**：
`[Showing lines A-B of T. Use offset=N to continue.]`（含 byte-limit 变体）与
`[R more lines in file. Use offset=N to continue.]`。
不要用宽泛的 `/\[[^\n]*\]$/`：那会把 `[section]`、`[1, 2]` 这类**合法尾行**也删掉，导致行数少算。
（`[Line N is X, exceeds ... limit. Use bash: ...]` 是整段输出、无前导换行，不会被命中。）

### 坑 6：真正「隐藏」一行必须 `renderShell: "self"` + 返回空 `Container`

- 默认 shell 下 `ToolExecutionComponent` 总会渲染构造函数里加的那个 `Spacer(1)` → 每行都留一个空行。
- 只有 `renderShell: "self"` 且渲染容器为空时，`ToolExecutionComponent.render()` 直接返回 `[]`，
  该行**完全不占屏幕**（连 Spacer 都被绕过）。
- 代价：self shell 下默认 Box 的背景/留白不再提供，需要自己用
  `new Box(1, 1, (t) => theme.bg("toolSuccessBg", t))` 补回来（进度行/汇总块/回退行都这么做了）。

### 坑 7：flush 必须幂等，且 flush 之后不能再改写 item

- `agent_end` / `agent_settled` / `session_shutdown` 都会调用 `flush()`：`current` 取走后立即置空，
  重复调用是 no-op。
- 迟到的 `finish()` / `fail()` 有 `item.status !== "run"` 守卫：被中断（已标记 `abort`）的工具
  在真正跑完后**不得**把状态改回 `ok`，否则会污染已写入 session 的汇总。
- 汇总写入失败（`appendEntry` 抛错）会被吞掉：TUI 上的 carrier 行仍会显示汇总块，不影响使用。
- 写进 session 的 `ids` / `items` / `lines` / `details` 都必须是**副本**（`.map(it => ({ ...it }))`）：
  条目一旦写入就不能再被内存对象的后续变更污染。
- 落盘后立即释放内存：`group.items` 清空、对应 `rowInvalidate` 项删除（该 Map 持有 `invalidate`
  闭包 → 会强引用整棵组件）。`groups`/`roles` 保留，历史行重绘/隐藏仍需要它们。

### 坑 8：运行期未登记的行要先隐藏，但 flush 时必须释放

`begin()`（登记）只发生在 `execute()` 里，而工具行在参数还在流式拼接时就已创建。所以：

- `runActive`（`agent_start` / `agent_end` 维护）为真时，**未在 `roles` 里的行返回空组件** →
  消除「先闪一下 v1 行」。
- 但这些行不能永久隐藏：被其它扩展在 `tool_call` 阶段拦下的工具永远不会走到 `execute`。
  因此它们先记入 `pendingOrphans`，`flush()` 时仍未登记的 → 加入 `visibleOrphans` 并重绘成 v1 行。
- 删掉这段兜底会使「被拦下的工具」**整行消失**（只看得到模型后续的文字说明）。

### 坑 9：HTML 导出是另一条渲染路径

`core/export-html/tool-renderer.js` 用同一份 `ToolRenderContext` 调我们的渲染器，但：

- 模板对 `bash/read/write/edit/ls` 有自带结构化渲染（`TEMPLATE_RENDERED_TOOLS`），**不调扩展渲染器**；
- 只有 `grep/find` 会走扩展渲染，且 `renderResult` 会被调**两次**（collapsed + expanded），
  两次的返回值各自立即转成 HTML——所以「在 call 槽里共享一个 Box、结果文本靠后来的 renderResult 填」
  这种玩法**在导出里不生效**（导出时 call 已经转完 HTML 了）；
- 扩展的结果渲染返回空时，模板会 `else if (result)` 回退成**原始输出文本**，所以导出**不丢数据**；
- `compact-tools.group` 是自定义 session 条目，导出器只渲染消息，**不渲染它**。

结论：不要为了「让导出好看」往隐藏行里塞内容，也不要期望导出里有汇总块。需要完整工具原文时就 `/export` 或看 JSONL。

> 附：无法可靠区分「TUI 渲染」与「导出渲染」（两者字段完全相同），所以不做导出特例。

### 坑 10：`session_shutdown` 里不要 `reset()`

`/reload` 后旧行的渲染器闭包仍绑定**旧实例**。若在 `session_shutdown` 里清空状态，
旧行会因 `roles` 丢失而重新变成**可见的 v1 行**（看起来像重复）。
`reset()` 只在 `session_start` 做；`session_shutdown` 只 `flush()`。

---

## 5. 关键 API 速查（pi 0.85.1）

```ts
// 定义工厂（从包根导出，保留全部元数据）
createReadToolDefinition(cwd, { autoResizeImages? })
createBashToolDefinition(cwd, { commandPrefix?, shellPath?, operations?, spawnHook?, exposeSessionEnvironment? })
createEditToolDefinition(cwd)   // 自带 renderShell: "self" + prepareArguments
createWriteToolDefinition(cwd) / createGrepToolDefinition(cwd)
createFindToolDefinition(cwd) / createLsToolDefinition(cwd)

// 工具渲染器
renderCall(args, theme, context)
renderResult(result, { expanded, isPartial }, theme, context)
//   context: { args, cwd, toolCallId, isError, expanded, isPartial, showImages,
//              lastComponent, state, invalidate(), executionStarted, argsComplete }
//   渲染器先被调用、之后才走真正的 render()，「就地更新组件」在 TUI 里安全（fallbackSlot 的共享
//   Box 依赖这一点）——但 HTML 导出不是（见坑 9）。

// TUI-only 持久内容（不进 LLM 上下文）
pi.appendEntry<T>("my-type", data)                      // 写 session 条目
pi.registerEntryRenderer<T>("my-type", (entry, { expanded }, theme) => Component | undefined)

// 设置
SettingsManager.create(cwd, getAgentDir(), { projectTrusted })
  .getShellPath() / .getShellCommandPrefix() / .getImageAutoResize()

// 隐藏行的机制
// renderShell === "self" 且渲染内容为空 → ToolExecutionComponent.render(width) === []
```

### details 形状（`result.details`）

| 工具 | 字段 |
| --- | --- |
| read | `{ truncation? }` |
| bash | `{ truncation?, fullOutputPath? }` |
| edit | `{ diff, patch, firstChangedLine? }` |
| grep | `{ truncation?, matchLimitReached?, linesTruncated? }` |
| find | `{ truncation?, resultLimitReached? }` |
| ls | `{ truncation?, entryLimitReached? }` |

`TruncationResult` 常用字段：`truncated`、`truncatedBy: "lines" | "bytes"`、
`outputLines`、`totalLines`、`firstLineExceedsLimit`。

### 与宿主组件的交互

- `CustomEntryComponent` 会**自己**在汇总块前加 `Spacer(1)`：entry 渲染器只返回内容，不要加外边距；
  返回 `undefined` 或空组件则条目不显示。
- 实时插入走 `entry_appended`，恢复会话走 `renderInitialMessages()`，两条路径都调用
  `addCustomEntryToChat()`，所以块都能显示。
- 该函数在存在 streaming 组件时把块插在它之前；`agent_end` 时流式组件通常已结束，块落在回答下方；
  中断时流式组件被移除，块同样落在末尾。

---

## 6. 自测

### 自动化

```bash
node extensions/compact-tools.selftest.mjs
```

用 pi 自己的 jiti + alias 加载扩展，用 stub `pi` / theme / ctx 驱动全流程（在临时目录里跑**真实**的
read/write/edit/bash），pi 包路径按 `PI_PKG` 环境变量 → `npm root -g` 依次解析，覆盖 24 个用例：

| 用例 | 断言 |
| --- | --- |
| A 混合请求（3×read + edit + 失败 bash） | 分类计数、修改文件名、失败提示；进行中只有 1 行可见且是进度行；结束后所有工具行 0 行；entry 数据与渲染结果逐字匹配 |
| B 同一文件改 3 次 | 操作数 3、文件名去重为 1 |
| C 12 个文件 | 只列 5 个 + `等 12 个文件` |
| D 同名文件（`a/x.ts`、`b/x.ts`） | 这两个显示相对路径，其余显示文件名 |
| E 无工具调用 | 不写 entry |
| F 中断 | 运行中项记为 `⚠️ 已中断`；只 flush 一次；flush 后迟到的完成不改写状态 |
| G 会话恢复 | 历史工具行全部隐藏；块可重放且明细来自条目数据 |
| H 未参与聚合的行 | 保持 v1 紧凑渲染（调用行 + 结果摘要） |
| I 注册元数据不变 | 注册表仍为这 7 个名字、`promptSnippet`/`promptGuidelines`/`prepareArguments` 齐全、无 `sendMessage`（**这是注册表校验，不代表激活集不变**，见 §8） |
| J 透传 | `execute` 返回内置结果**同一引用**（用 shim 把 read 的返回值换成哨兵对象验证） |
| K 无闪变 + 孤儿兜底 | 运行期未登记的行渲染 0 行；登记后直接是进度行；flush 后仍未登记的行恢复成 v1 行且不计入汇总 |
| L 进度行指向最新项 | 并行 3 次调用，最先启动的先跑完 → 进度行仍指向**第 3 个** |
| M `ls` 类别 | 第 1 行为 `🔧 本次 2 个操作：📖 读取 1 个文件 · 📂 查看 1 个目录`，明细为 `✓ 查看 pkg` |
| N 条目体积 + 恢复 | 25 次调用 → `v === 2`、`ids.length === 25`、`items.length === 20`、`detailTotal === 25`；恢复后全部 25 行都隐藏 |
| O 畸形数据 + ctx 防御 | 非法 `ids`/未知 `cat` 被跳过而不报错；ctx 缺 `cwd`/`isProjectTrusted` 时仍能成功执行 |
| P read 尾行 | 文件以 `[section]` 结尾时仍统计 5 行（截断提示只匹配已知文案，不误删合法尾行） |
| Q 明细首尾兼顾 | 25 次调用 → `details.length === 21`（5 首 + 1 省略 + 15 尾），中间项不出现，末项保留 |
| R 连续两次请求 | 第一次 flush 清空 items 后历史行仍隐藏，第二次请求独立聚合 |
| S edit 行分段着色 | 展开后含 `[accent]seg.ts[/]`、`[toolDiffAdded]+1[/]`、`[toolDiffRemoved]−1[/]`；`✓ 修改 `、括号、` / ` 仍包在 `[toolOutput]` 内；并断言 `data.v === 2`、`details[].text` 逐字不变、`segs` 拼接等于 `text` |
| T 只有末段上色 | `src/deep/file.ts` → 有 `[accent]file.ts[/]`，目录前缀 `[toolOutput]src/deep/[/]` 不得带 accent |
| U write 行 | `✓ 修改 log.ts` 含 `[accent]log.ts[/]`，且不出现任何 `toolDiff*` 色段（write 无 diff 统计） |
| V 其它类别不上色 | 同块的 `read`/`ls` 行整行单色且无内嵌色段；同块 `edit` 行正常着色（证明是按类别选择） |
| W 失败/省略不强拆色 | 失败 edit 行 `segs === undefined` 且整行 `[error]`；省略行 `segs === undefined` 且 `[muted]` |
| X 恢复后配色仍在 | 新实例 `session_start` 吃下 entry 后仅用条目数据渲染，`[accent]`/`[toolDiffAdded]`/`[toolDiffRemoved]` 标记仍在 |

### 手动（TUI）

1. 多步请求：运行期只出现一行进度；结束后回答下方 1 个块，工具行消失；`Ctrl+O` 展开含 `+a / −r`、
   错误正文、命令，>20 项时首尾都在、中间有省略标记。
2. `pi -c` 恢复：历史请求各 1 个块，无幽灵行，块可展开。
3. 窄终端（80 列）汇总块不溢出；`/reload` 行为不变且不复活旧行；`PI_COMPACT_TOOLS_AGGREGATE=0`
   回到 v1 且不写 entry。
4. 失败命令：块第 3 行出现 `⚠️ N 个操作失败：...`。

---

## 7. 常见问题

**Q: 为什么我只看得到一行「处理中」/ 历史工具行不见了？**
这就是聚合模式（§2）：其它工具行都是零高度，历史行被折叠进对应块。想要逐行显示就
`PI_COMPACT_TOOLS_AGGREGATE=0`。被其它扩展拦下、没执行的行不会消失（坑 8）。

**Q: `/export` 导出的 HTML 为什么和界面不一样，也没有汇总块？**
导出是另一条渲染路径，详见坑 9；导出不丢数据，但没有汇总块。

**Q: 升级 pi 后要检查什么？**
1. `createXxxToolDefinition` 是否仍从包根导出；2. `ToolRenderContext.isError` / `toolCallId` 是否仍在；
3. 内置工具是否新增了必须透传的 options（对照 `AgentSession._buildRuntime()`）；
4. `renderShell: "self"` 的空渲染是否仍返回 `[]`（对照 `ToolExecutionComponent.render()`）；
5. grep/find/ls 的「无结果」文案与 read 的截断提示文案是否变了（坑 5 的正则会失配）；
6. `entry_appended` + `registerEntryRenderer` 的签名是否变了。

**Q: `Available tools:` 里看不到 read/bash？** 见坑 1（注册时漏了 `promptSnippet`）。
**Q: `shellPath` / `shellCommandPrefix` 没生效？** 见坑 3。
**Q: 怎么临时关掉这个扩展？** 改名（如 `compact-tools.ts.off`）后 `/reload`；或 `pi -ne`（跳过全部扩展）。
**Q: `Ctrl+O` 没反应？** `app.tools.expand` 可能被你改过，见 `keybindings.json` 与 `docs/keybindings.md`。

---

## 8. 已知取舍

- **上下文 / token**：本扩展注册 7 个同名内置工具；pi 默认会激活所有扩展注册的工具，所以在
  未配置 `defaultTools` 时，`grep`/`find`/`ls` 会从「默认关闭」变为「默认开启」。这三个工具的
  schema + `promptSnippet` ≈ **2.2KB/请求**（约 **550–750 token**；128K 上下文约 0.5%，命中
  prompt cache 后按 cache-read 计费）。其余上下文增量为 0。想关掉：`pi --exclude-tools grep,find,ls`
  （代价是扩展也不再渲染/聚合它们）。
- **session 文件**：每次用到工具的请求写一条 `compact-tools.group` 自定义条目（**不进 LLM 上下文**），
  实测约 **170–280 字节/次工具调用**（10 次≈2.8KB，45 次≈7.8KB）。其中**会改动文件的成功明细行**多一个 `segs`
  分段数组（约 **+60–90 字节/行**，仅 edit/write，且明细本就封顶 20 项），其余行不带该字段。`items`/`details` 封顶 20 项，
  但 `ids` 不封顶，超长请求会随调用数线性增长；`details` 与 `items` 有部分重复存储。恢复会话时会
  遍历全部条目重建映射（一次性 CPU/内存开销）。
- 隐藏的工具行不能再被单击展开；明细集中在汇总块的 `Ctrl+O`。
- 只有本扩展接管的 7 个内置工具会被聚合；其它扩展的工具保持原样（被拦下的本扩展工具由
  `visibleOrphans` 兜底恢复显示）。
- 内存：`groups` / `roles` 保留本会话的映射（历史行重绘与隐藏需要）；`items` 与 `rowInvalidate`
  在每次 flush 后释放，`session_start` 时整体清空。
- 文件名同名冲突时退化为相对路径（消歧默认行为）。
- 不做导出特例（无法可靠区分 TUI 与导出渲染，见坑 9）。

---

## 9. 变更记录

- **v6（明细行分段配色）**：聚合模式展开明细中，「会改动文件的行」（edit / write）新增分段配色——
  文件名末段 `accent`、`+a` `toolDiffAdded`、`−r` `toolDiffRemoved`，其余片段（`✓ 修改 ` 前缀、目录前缀、
  括号、` / `）保持 `toolOutput` 灰；读取 / 查看 / 搜索 / 命令与失败 / 中断 / 省略行**一律不拆色**。
  实现走 `Detail.segs` 可选字段，**`text` 与条目版本 `v: 2` 均不变**（旧条目、旧断言、HTML 导出回退不受影响，
  无需迁移）；`segs` 随条目落盘，`pi -c` 恢复后颜色依旧。新增三个可调常量与自测 S–X（共 24 例）。
- **v5（文档校正）**：澄清「只影响 TUI」——注册 7 个同名工具会把 `grep`/`find`/`ls` 一并激活
  （≈ +2.2KB/请求，约 550–750 token）；补记 session 文件 ≈170–280 B/次调用的磁盘开销与 `ids` 不封顶。
- **v4（修复与去重）**：`stripReadNotices` 只匹配已知提示（坑 5）；明细改「首 5 + 末 15」并给出省略标记；
  flush 后释放 `items`/`rowInvalidate`（坑 7）；自测改可移植路径 + 新增 P/Q/R（共 18 例）并删除不实表述；文档去重。
- **v3**：消除工具行闪变与孤儿兜底（坑 8）；进度行指向最新项；`ls` 独立类别；条目升级 v2（坑 7）；
  `scopeOf` 缺字段回落；`session_shutdown` 只 flush 不 reset（坑 10）。
- **v2**：新增聚合模式与汇总块；`renderShell: "self"`（坑 6）；`flush()` 幂等（坑 7）；会话恢复重建映射。
- **v1**：spread `createXxxToolDefinition`（坑 1/2）；透传 settings（坑 3）；`context.isError`（坑 4）；
  修正无结果与 read 截断提示的行数统计（坑 5）。
