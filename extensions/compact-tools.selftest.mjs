/**
 * compact-tools 自测脚本（不参与扩展加载：pi 只扫描 *.ts / *.js）
 *
 *   node extensions/compact-tools.selftest.mjs
 *
 * 用 pi 自己的 jiti + alias 加载 compact-tools.ts，用 stub pi/theme/ctx 驱动
 * 「工具调用 → 渲染 → 请求结束 → 会话恢复」全流程，并验证对模型上下文的零影响。
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 本扩展文件（相对脚本定位，不再硬编码用户路径） */
const EXT = fileURLToPath(new URL("./compact-tools.ts", import.meta.url));

/** 定位 pi 包：优先 PI_PKG 环境变量，其次 `npm root -g` */
function resolvePiPackage() {
	const override = process.env.PI_PKG;
	if (override) {
		if (existsSync(join(override, "dist", "index.js"))) return override;
		throw new Error(`PI_PKG=${override} 下没有 dist/index.js`);
	}
	try {
		const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		const candidate = join(root, "@earendil-works", "pi-coding-agent");
		if (existsSync(join(candidate, "dist", "index.js"))) return candidate;
	} catch {
		// 落到下面的统一报错
	}
	throw new Error("找不到 pi 包：设置环境变量 PI_PKG 指向 @earendil-works/pi-coding-agent 目录（需含 dist/index.js）");
}

const PI_PKG = resolvePiPackage();
// 别名 / file:// URL 统一用正斜杠（Windows 反斜杠在 file:// 下非法）
const PI_PKG_SLASH = PI_PKG.replace(/\\/g, "/");
const { createJiti } = await import(`file://${PI_PKG_SLASH}/node_modules/jiti/lib/jiti-static.mjs`);

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
/**
 * 保留颜色键的 stub 主题：故意不用 ANSI，否则会被 strip() 吃掉。
 * 渲染后一行长这样：`[toolOutput]✓ 修改 [/][accent]app.ts[/][toolOutput]（[/][toolDiffAdded]+1[/]…`
 * 于是可以精确断言「哪一段是什么颜色」。
 */
const markerTheme = { fg: (c, t) => `[${c}]${t}[/]`, bg: (_c, t) => t, bold: (t) => t };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const lines = (component, width = 120) => component.render(width).map(strip);
const textOf = (component, width = 120) => lines(component, width).join("\n");
/** 去掉 Box 上下留白行，便于断言内容 */
const content = (component, width = 120) =>
	lines(component, width)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

/** 用指定主题（默认 markerTheme）展开渲染汇总块。宽度取 400：标记会撑长字符串，窄宽度下会被换行截断 */
const expandWith = (stub, data, t = markerTheme) =>
	content(stub.entryRenderers.get("compact-tools.group")({ data }, { expanded: true }, t), 400);

const WORK = mkdtempSync(join(tmpdir(), "compact-tools-selftest-"));
const CWD = WORK.replace(/\\/g, "/");

// ---------------------------------------------------------------- harness

function loadExtension(aliasPkg) {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: {
			"@earendil-works/pi-coding-agent": aliasPkg ?? `${PI_PKG_SLASH}/dist/index.js`,
			"@earendil-works/pi-tui": `${PI_PKG_SLASH}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		},
	});
	return jiti.import(EXT, { default: true });
}

function makeStub() {
	const tools = new Map();
	const entryRenderers = new Map();
	const handlers = new Map();
	const entries = [];
	const sent = [];
	const pi = {
		registerTool: (t) => tools.set(t.name, t),
		registerEntryRenderer: (type, renderer) => entryRenderers.set(type, renderer),
		appendEntry: (type, data) => entries.push({ type, data }),
		on: (event, fn) => handlers.set(event, [...(handlers.get(event) ?? []), fn]),
		sendMessage: (...a) => sent.push(["sendMessage", ...a]),
		sendUserMessage: (...a) => sent.push(["sendUserMessage", ...a]),
	};
	return { pi, tools, entryRenderers, handlers, entries, sent };
}

function ctxFor(sessionEntries = []) {
	return {
		cwd: CWD,
		isProjectTrusted: () => true,
		model: { input: ["text", "image"] },
		sessionManager: {
			getSessionId: () => "selftest",
			getSessionFile: () => undefined,
			getEntries: () => sessionEntries,
		},
	};
}

/** 模拟一行工具卡片：renderCall / renderResult + invalidate 重绘（等价于 ToolExecutionComponent） */
function makeRow(tools, id, name, args) {
	const tool = tools.get(name);
	const row = { id, name, args, result: undefined, callLines: [], resultLines: [], redraws: 0 };
	row.state = {};
	row.context = {
		toolCallId: id,
		state: row.state,
		cwd: CWD,
		expanded: false,
		isPartial: true,
		isError: false,
		invalidate: () => draw(row),
	};
	function draw(r) {
		r.redraws++;
		// 两步：先跑两个 slot 的渲染器（会就地更新组件），再渲染组件树
		// —— 等价于 ToolExecutionComponent.updateDisplay() 之后再走一次 render()
		const callComponent = tool.renderCall(r.args, theme, r.context);
		const resultComponent = r.result ? tool.renderResult(r.result, { expanded: false, isPartial: false }, theme, r.context) : undefined;
		r.callLines = lines(callComponent);
		r.resultLines = resultComponent ? lines(resultComponent) : [];
	}
	row.draw = () => draw(row);
	row.visible = () => [...row.callLines, ...row.resultLines].filter((l) => l.trim().length > 0);
	row.draw();
	return row;
}

async function settled(promise) {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

/** 驱动一次工具调用（流式出现 → 执行 → 结果/异常） */
async function invoke(stub, rows, id, name, args, ctx, render) {
	const row = makeRow(stub.tools, id, name, args);
	rows.push(row);
	const res = await settled(stub.tools.get(name).execute(id, args, undefined, undefined, ctx));
	row.context.isPartial = false;
	row.context.isError = !res.ok;
	if (res.ok) {
		row.result = render ? render(res.value) : res.value;
	}
	row.draw();
	return { row, ...res };
}

async function flushEvents(stub, event, ctx) {
	for (const fn of stub.handlers.get(event) ?? []) await fn({ type: event }, ctx);
}

async function startSession(stub, sessionEntries = []) {
	const ctx = ctxFor(sessionEntries);
	await flushEvents(stub, "session_start", ctx);
	return ctx;
}

const checks = [];
function check(name, fn) {
	checks.push({ name, fn });
}

// ---------------------------------------------------------------- 用例

check("A. 混合请求：计数 / 修改文件名 / 失败提示 / 仅一个进度行可见", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);

	writeFileSync(join(WORK, "a.txt"), "a\nb\nc\n");
	writeFileSync(join(WORK, "b.txt"), "b\n");
	writeFileSync(join(WORK, "c.txt"), "c\n");
	writeFileSync(join(WORK, "app.ts"), "const a = 1;\n");

	const rows = [];
	const r1 = await invoke(stub, rows, "t1", "read", { path: "a.txt" }, ctx);
	const r2 = await invoke(stub, rows, "t2", "read", { path: "b.txt" }, ctx);
	const r3 = await invoke(stub, rows, "t3", "read", { path: "c.txt" }, ctx);
	const r4 = await invoke(stub, rows, "t4", "edit", { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }, ctx);
	const r5 = await invoke(stub, rows, "t5", "bash", { command: "exit 1" }, ctx);

	assert.equal(r1.ok && r2.ok && r3.ok && r4.ok, true, "read/edit 应成功");
	assert.equal(r5.ok, false, "bash 失败应抛错");

	// 进行中：只有最后一行可见，且只剩一行
	const visible = rows.filter((r) => r.visible().length > 0);
	assert.equal(visible.length, 1, `只应有 1 行可见，实际 ${visible.length}`);
	assert.match(visible[0].id, /^t5$/, "可见行应为最近一次工具调用");
	assert.match(textOf({ render: () => visible[0].visible() }), /处理中/, "可见行应为进度行");

	await flushEvents(stub, "agent_end", ctx);

	// 结束后：所有工具行消失
	assert.equal(rows.filter((r) => r.visible().length > 0).length, 0, "结束后所有工具行都应隐藏");

	// 汇总条目
	assert.equal(stub.entries.length, 1, "应写入 1 条汇总 entry");
	const data = stub.entries[0].data;
	assert.equal(stub.entries[0].type, "compact-tools.group");
	assert.equal(data.items.length, 5);
	assert.deepEqual(
		data.lines.map((l) => l.text),
		[
			"🔧 本次 5 个操作：✏️ 修改 1 个文件 · 📖 读取 3 个文件 · 💻 执行 1 条命令",
			"📝 app.ts",
			"⚠️ 1 个操作失败：Command exited with code 1",
		],
	);
	assert.equal(data.hasError, true);
	assert.equal(data.detailTotal, 5);
	assert.match(data.details[3].text, /^✓ 修改 app\.ts（\+1 \/ −1）$/);
	assert.match(data.details[4].text, /^✗ 执行命令 exit 1\s+Command exited with code 1$/);

	// entry 渲染器
	const renderer = stub.entryRenderers.get("compact-tools.group");
	assert.ok(renderer, "应注册 entry 渲染器");
	const collapsed = content(renderer({ data }, { expanded: false }, theme));
	assert.deepEqual(collapsed, [
		"🔧 本次 5 个操作：✏️ 修改 1 个文件 · 📖 读取 3 个文件 · 💻 执行 1 条命令",
		"📝 app.ts",
		"⚠️ 1 个操作失败：Command exited with code 1",
	]);
	const expanded = content(renderer({ data }, { expanded: true }, theme));
	assert.equal(expanded.length, collapsed.length + 5, "展开后应多出 5 行明细");
});

check("B. 同一文件改 3 次：操作数按 3 计，文件名去重", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "same.ts"), "let v = 1;\n");

	const rows = [];
	let file = "let v = 1;\n";
	for (let i = 0; i < 3; i++) {
		const next = `let v = ${i + 2};\n`;
		await invoke(stub, rows, `s${i}`, "edit", { path: "same.ts", edits: [{ oldText: file, newText: next }] }, ctx);
		file = next;
	}
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.match(data.lines[0].text, /本次 3 个操作/);
	assert.match(data.lines[0].text, /修改 3 个文件/);
	assert.equal(data.lines[1].text, "📝 same.ts");
});

check("C. 12 个文件：只列 5 个 + 等 12 个文件", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);

	const rows = [];
	for (let i = 1; i <= 12; i++) {
		await invoke(stub, rows, `w${i}`, "write", { path: `f${String(i).padStart(2, "0")}.ts`, content: `// ${i}\n` }, ctx);
	}
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.lines[1].text, "📝 f01.ts、f02.ts、f03.ts、f04.ts、f05.ts 等 12 个文件");
});

check("D. 同名文件：冲突的退化为相对路径", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);

	const rows = [];
	await invoke(stub, rows, "d1", "write", { path: "a/x.ts", content: "1\n" }, ctx);
	await invoke(stub, rows, "d2", "write", { path: "b/x.ts", content: "2\n" }, ctx);
	await invoke(stub, rows, "d3", "write", { path: "y.ts", content: "3\n" }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	assert.equal(stub.entries[0].data.lines[1].text, "📝 a/x.ts、b/x.ts、y.ts");
});

check("E. 没有工具调用：不产生 entry", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	await flushEvents(stub, "agent_end", ctx);
	await flushEvents(stub, "agent_settled", ctx);
	assert.equal(stub.entries.length, 0);
});

check("F. 中断：运行中的工具标为已中断，且只 flush 一次", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "long.txt"), "x\n".repeat(50));

	// 模拟中断：execute 已经登记 item，但还没跑完就 flush
	const row = makeRow(stub.tools, "a1", "read", { path: "long.txt" });
	const pending = settled(stub.tools.get("read").execute("a1", { path: "long.txt" }, undefined, undefined, ctx));
	row.draw();
	assert.match(row.visible().join("\n"), /处理中 1 个操作/, "中断前应显示进度行");

	await flushEvents(stub, "agent_settled", ctx);
	await flushEvents(stub, "agent_end", ctx); // 幂等：不应重复写入
	assert.equal(stub.entries.length, 1, "应只 flush 一次");
	const data = stub.entries[0].data;
	assert.equal(data.details[0].kind, "abort");
	assert.match(data.details[0].text, /⚠️/);
	assert.equal(data.lines[0].text, "🔧 本次 1 个操作：📖 读取 1 个文件");
	assert.equal(data.details[0].text, "⚠️ 读取 long.txt  已中断");
	assert.equal(stub.entries[0].data.items[0].errText, "已中断");

	// 迟到的完成不再改写已 flush 的汇总
	const late = await pending;
	assert.equal(late.ok, true, "读取本身仍应成功");
	assert.equal(stub.entries[0].data.items[0].status, "abort", "flush 后迟到的 finish 不得改写状态");
});

check("G. 会话恢复：历史工具行全部隐藏，汇总块可重放", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "r.txt"), "r\n");
	const rows = [];
	await invoke(stub, rows, "g1", "read", { path: "r.txt" }, ctx);
	await invoke(stub, rows, "g2", "write", { path: "g.ts", content: "g\n" }, ctx);
	await flushEvents(stub, "agent_end", ctx);
	const entries = stub.entries.map((e) => ({ type: "custom", customType: e.type, data: e.data }));

	// 新实例 + 恢复会话
	const stub2 = makeStub();
	await (await loadExtension())(stub2.pi);
	await startSession(stub2, entries);

	const restoredRows = [
		makeRow(stub2.tools, "g1", "read", { path: "r.txt" }),
		makeRow(stub2.tools, "g2", "write", { path: "g.ts", content: "g\n" }),
	];
	for (const row of restoredRows) {
		row.result = { content: [{ type: "text", text: "..." }], details: {} };
		row.draw();
		assert.equal(row.visible().length, 0, `${row.id} 恢复后应隐藏`);
	}
	const renderer = stub2.entryRenderers.get("compact-tools.group");
	const text = content(renderer({ data: entries[0].data }, { expanded: true }, theme)).join("\n");
	assert.match(text, /本次 2 个操作/);
	assert.match(text, /✓ 读取 r\.txt/);
});

check("H. 未参与聚合的行（其它扩展/历史行）保持 v1 紧凑渲染", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	const row = makeRow(stub.tools, "foreign-1", "read", { path: "x/y.ts", offset: 10, limit: 5 });
	assert.equal(row.visible().length, 1, "未聚合行应可见");
	row.result = { content: [{ type: "text", text: "l1\nl2\n" }], details: {} };
	row.draw();
	assert.match(row.visible().join("\n"), /✓ 2 行/);
});

check("I. 对模型上下文零影响：工具集 / 提示元数据 / 不注入消息", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	assert.deepEqual([...stub.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
	for (const [name, tool] of stub.tools) {
		assert.ok(tool.promptSnippet, `${name} 应保留 promptSnippet`);
		assert.equal(tool.renderShell, "self", `${name} 应为 self shell（隐藏行需要）`);
		assert.ok(tool.parameters, `${name} 应保留 parameters`);
	}
	assert.equal(stub.tools.get("read").promptGuidelines.length, 1);
	assert.equal(stub.tools.get("edit").promptGuidelines.length, 4);
	assert.equal(typeof stub.tools.get("edit").prepareArguments, "function");
	assert.equal(stub.sent.length, 0, "不得注入任何消息");

	// v1 模式：仍然只有这 7 个工具
	const prev = process.env.PI_COMPACT_TOOLS_AGGREGATE;
	process.env.PI_COMPACT_TOOLS_AGGREGATE = "0";
	const stub2 = makeStub();
	await (await loadExtension())(stub2.pi);
	if (prev === undefined) delete process.env.PI_COMPACT_TOOLS_AGGREGATE;
	else process.env.PI_COMPACT_TOOLS_AGGREGATE = prev;
	const ctx = await startSession(stub2);
	const row = makeRow(stub2.tools, "v1", "read", { path: "r.txt" });
	await stub2.tools.get("read").execute("v1", { path: "r.txt" }, undefined, undefined, ctx);
	row.result = { content: [{ type: "text", text: "r\n" }], details: {} };
	row.draw();
	assert.match(row.visible().join("\n"), /read r\.txt/, "v1 模式应显示紧凑调用行");
	assert.match(row.visible().join("\n"), /✓ 1 行/, "v1 模式应显示结果摘要");
	await flushEvents(stub2, "agent_end", ctx);
	assert.equal(stub2.entries.length, 0, "v1 模式不应写汇总 entry");
});

check("J. execute 原样透传内置结果（引用相同）+ 透传 settings", async () => {
	const sentinel = { content: [{ type: "text", text: "SENTINEL" }], details: { fromShim: true } };
	globalThis.__piReadSentinel = sentinel;
	const shimPath = join(WORK, "pi-shim.mjs");
	const shimUrl = `file://${shimPath.replace(/\\/g, "/")}`;
	writeFileSync(
		shimPath,
		[
			`export * from "file://${PI_PKG_SLASH}/dist/index.js";`,
			`import * as real from "file://${PI_PKG_SLASH}/dist/index.js";`,
			`export function createReadToolDefinition(cwd, opts) {`,
			`  const d = real.createReadToolDefinition(cwd, opts);`,
			`  return { ...d, execute: async () => globalThis.__piReadSentinel };`,
			`}`,
		].join("\n"),
	);
	const stub = makeStub();
	await (await loadExtension(shimUrl))(stub.pi);
	const ctx = await startSession(stub);
	const res = await stub.tools.get("read").execute("j1", { path: "whatever.txt" }, undefined, undefined, ctx);
	assert.equal(res, sentinel, "execute 必须原样返回内置结果（同一引用）");
	await flushEvents(stub, "agent_end", ctx);
	assert.equal(stub.entries[0].data.items[0].status, "ok");
});

check("K. 运行期不闪 v1 样式；被拦下的行在 flush 后恢复显示", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	await flushEvents(stub, "agent_start", ctx);

	// 模拟「被其它扩展在 tool_call 阶段拦下」：行出现了，但 execute 永远不会跑
	const blocked = makeRow(stub.tools, "k-blocked", "read", { path: "blocked.txt" });
	assert.equal(blocked.visible().length, 0, "运行期未登记的行应隐藏");

	// 正常调用：execute 一开始登记就变成进度行，不应先显示 v1 行
	const rows = [];
	const row = makeRow(stub.tools, "k-ok", "read", { path: "a.txt" });
	rows.push(row);
	const pending = settled(stub.tools.get("read").execute("k-ok", { path: "a.txt" }, undefined, undefined, ctx));
	assert.match(row.visible().join("\n"), /处理中 1 个操作/, "已登记的行应直接是进度行");
	assert.doesNotMatch(row.visible().join("\n"), /read a\.txt/, "不应先渲染 v1 调用行");
	await pending;

	await flushEvents(stub, "agent_end", ctx);
	assert.equal(stub.entries.length, 1, "只有真实执行的工具才写 entry");
	assert.deepEqual(stub.entries[0].data.ids, ["k-ok"], "被拦下的行不得计入汇总");
	assert.equal(blocked.visible().length, 1, "flush 后被拦下的行应恢复成 v1 调用行（尚无结果）");
	assert.match(blocked.visible().join("\n"), /read blocked\.txt/);
});

check("L. 进度行指向最新的运行中项（并行调用）", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	await flushEvents(stub, "agent_start", ctx);

	const fire = async (id, name, args) => {
		const row = makeRow(stub.tools, id, name, args);
		const p = settled(stub.tools.get(name).execute(id, args, undefined, undefined, ctx));
		row.draw();
		return { row, p };
	};
	const a = await fire("l1", "read", { path: "a.txt" });
	const b = await fire("l2", "read", { path: "b.txt" });
	const c = await fire("l3", "read", { path: "c.txt" });

	const view = () => c.row.visible().join("\n");
	assert.match(view(), /处理中 3 个操作/);
	assert.match(view(), /最新：📖 读取 c\.txt/);
	await a.p; // 最先启动的那个先跑完
	assert.match(view(), /最新：📖 读取 c\.txt/, "应继续指向最新运行中的项，而不是最旧的");
	await b.p;
	await c.p;
	await flushEvents(stub, "agent_end", ctx);
	assert.equal(stub.entries[0].data.items.length, 3);
});

check("M. ls 独立成「查看目录」类别", async () => {
	mkdirSync(join(WORK, "pkg"), { recursive: true });
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	const rows = [];
	await invoke(stub, rows, "m1", "read", { path: "a.txt" }, ctx);
	await invoke(stub, rows, "m2", "ls", { path: "pkg" }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.lines[0].text, "🔧 本次 2 个操作：📖 读取 1 个文件 · 📂 查看 1 个目录");
	assert.equal(data.details[1].text, "✓ 查看 pkg");
});

check("N. 条目体积：ids 全量、items 封顶；恢复时全部行都隐藏", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	const rows = [];
	for (let i = 1; i <= 25; i++) await invoke(stub, rows, `n${i}`, "read", { path: "a.txt" }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.v, 2);
	assert.equal(data.ids.length, 25, "ids 必须覆盖全部调用");
	assert.equal(data.items.length, 20, "items 应封顶到 DETAIL_MAX");
	assert.equal(data.detailTotal, 25);

	const stub2 = makeStub();
	await (await loadExtension())(stub2.pi);
	await startSession(stub2, stub.entries.map((e) => ({ type: "custom", customType: e.type, data: e.data })));
	for (let i = 1; i <= 25; i++) {
		const row = makeRow(stub2.tools, `n${i}`, "read", { path: "a.txt" });
		row.result = { content: [{ type: "text", text: "a\n" }], details: {} };
		row.draw();
		assert.equal(row.visible().length, 0, `n${i} 恢复后应隐藏（含未进 items 的那 5 个）`);
	}
});

check("O. 畸形条目容错 + ctx 缺字段时的防御", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const bad = {
		type: "custom",
		customType: "compact-tools.group",
		data: {
			v: 2,
			id: "bad",
			lines: [{ text: "🔧 本次 1 个操作", kind: "title" }],
			details: [],
			detailTotal: 1,
			hasError: false,
			ids: [undefined, null, "ok1", "", 5],
			items: [{ cat: "nope" }, { id: "ok2", cat: "edit", label: "z", status: "ok", tool: "edit" }],
		},
	};
	await startSession(stub, [bad]); // 不得抛错

	const okRow = makeRow(stub.tools, "ok1", "read", { path: "a.txt" });
	assert.equal(okRow.visible().length, 0, "合法 id 应被登记并隐藏");
	const dangling = makeRow(stub.tools, "ok2", "read", { path: "a.txt" });
	assert.equal(dangling.visible().length, 1, "v2 的 ids 生效时，未列出的 id 不隐藏（回落 v1 行）");

	// ctx 缺少 cwd / isProjectTrusted：应回落 process.cwd() 与 trusted=true，而不是把工具打挂
	writeFileSync(join(WORK, "def.txt"), "d\n");
	const bare = { model: { input: ["text"] }, sessionManager: { getSessionId: () => "t", getSessionFile: () => undefined } };
	const res = await settled(stub.tools.get("read").execute("o1", { path: join(WORK, "def.txt") }, undefined, undefined, bare));
	assert.equal(res.ok, true, `ctx 缺字段时仍应成功：${res.ok ? "" : res.error?.message}`);
});

check("P. 结尾为 [section] 的合法行不被当截断提示剔除", async () => {
	const prev = process.env.PI_COMPACT_TOOLS_AGGREGATE;
	process.env.PI_COMPACT_TOOLS_AGGREGATE = "0";
	try {
		const stub = makeStub();
		await (await loadExtension())(stub.pi);
		const ctx = await startSession(stub);
		const file = join(WORK, "p.conf");
		writeFileSync(file, "a=1\nb=2\nc=3\nd=4\n[section]\n");
		const row = makeRow(stub.tools, "p1", "read", { path: file });
		const res = await settled(stub.tools.get("read").execute("p1", { path: file }, undefined, undefined, ctx));
		assert.equal(res.ok, true, `read 应成功：${res.ok ? "" : res.error?.message}`);
		row.result = res.value;
		row.draw();
		assert.match(row.visible().join("\n"), /✓ 5 行/, `应统计 5 行（含 [section]）：${row.visible().join(" | ")}`);
	} finally {
		if (prev === undefined) delete process.env.PI_COMPACT_TOOLS_AGGREGATE;
		else process.env.PI_COMPACT_TOOLS_AGGREGATE = prev;
	}
});

check("Q. 明细首尾兼顾：>20 项时保留最新并给出省略标记", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	const rows = [];
	// 用不存在的不同文件名，让每条明细可区分（read 会抛 ENOENT，但 item 仍被登记）
	for (let i = 1; i <= 25; i++) await invoke(stub, rows, `q${i}`, "read", { path: `q${i}.txt` }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.detailTotal, 25);
	assert.equal(data.details.length, 21, "应为 5 首 + 1 省略 + 15 尾");
	assert.equal(data.details[5].kind, "omit");
	assert.match(data.details[5].text, /省略 5 项/);
	assert.match(data.details[0].text, /q1\.txt/);
	assert.match(data.details[4].text, /q5\.txt/);
	assert.match(data.details[6].text, /q11\.txt/);
	assert.match(data.details[20].text, /q25\.txt/);
	const joined = data.details.map((d) => d.text).join("\n");
	for (let i = 6; i <= 10; i++) assert.doesNotMatch(joined, new RegExp(`q${i}\\.txt`), `中间被省略的 q${i} 不应出现`);
	assert.equal(data.items.length, 20, "条目 items 同样封顶 20");
});

check("R. 连续两次请求：清空 items 后历史仍隐藏、第二次独立聚合", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "r1.txt"), "r\n");

	const rows1 = [];
	await invoke(stub, rows1, "r-1", "read", { path: "r1.txt" }, ctx);
	await flushEvents(stub, "agent_end", ctx);
	assert.equal(stub.entries.length, 1);
	assert.equal(rows1.filter((r) => r.visible().length > 0).length, 0, "第一次请求的行结束后应隐藏");

	const rows2 = [];
	await invoke(stub, rows2, "r-2", "write", { path: "r2.txt", content: "x\n" }, ctx);
	assert.match(rows2[0].visible().join("\n"), /处理中/, "第二次请求进行中应显示进度行");
	await flushEvents(stub, "agent_end", ctx);

	assert.equal(stub.entries.length, 2);
	assert.deepEqual(stub.entries[1].data.ids, ["r-2"]);
	assert.equal(rows1.filter((r) => r.visible().length > 0).length, 0, "清空 items 后历史行仍保持隐藏");
});

check("S. edit 明细行分段着色：文件名 accent / +a 绿 / −r 红，且 text 逐字不变", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "seg.ts"), "const a = 1;\n");

	const rows = [];
	await invoke(stub, rows, "s1", "edit", { path: "seg.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	// 回归：条目格式与 text 都不得因配色而变
	assert.equal(data.v, 2, "只新增可选字段，条目版本仍是 v2（无需迁移）");
	assert.equal(data.details[0].text, "✓ 修改 seg.ts（+1 / −1）", "text 必须与改动前逐字一致");
	assert.equal(data.details[0].segs.map((s) => s.t).join(""), data.details[0].text, "segs 拼接必须等于 text");

	const line = expandWith(stub, data).find((l) => l.includes("✓ 修改"));
	assert.ok(line, `应渲染出该明细行：${expandWith(stub, data).join(" | ")}`);
	assert.match(line, /\[accent\]seg\.ts\[\/\]/, "文件名末段应为 accent");
	assert.match(line, /\[toolDiffAdded\]\+1\[\/\]/, "+1 应为绿（toolDiffAdded）");
	assert.match(line, /\[toolDiffRemoved\]−1\[\/\]/, "−1 应为红（toolDiffRemoved）");
	assert.match(line, /\[toolOutput\]✓ 修改 \[\/\]/, "✓ 修改 前缀应保持 toolOutput 灰");
	assert.match(line, /\[toolOutput\]（\[\/\]/, "左括号应保持灰");
	assert.match(line, /\[toolOutput\] \/ \[\/\]/, "「 / 」分隔符应保持灰");
	assert.match(line, /\[toolOutput\]）\[\/\]/, "右括号应保持灰");
});

check("T. 只有路径末段上色：目录前缀保持灰", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	mkdirSync(join(WORK, "src/deep"), { recursive: true });
	writeFileSync(join(WORK, "src/deep/file.ts"), "const v = 1;\n");

	const rows = [];
	await invoke(stub, rows, "t1", "edit", { path: "src/deep/file.ts", edits: [{ oldText: "const v = 1;", newText: "const v = 2;" }] }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.details[0].text, "✓ 修改 src/deep/file.ts（+1 / −1）");
	const line = expandWith(stub, data).find((l) => l.includes("✓ 修改"));
	assert.ok(line, `应渲染出该明细行：${expandWith(stub, data).join(" | ")}`);
	assert.match(line, /\[accent\]file\.ts\[\/\]/, "末段文件名应为 accent");
	assert.match(line, /\[toolOutput\]src\/deep\/\[\/\]/, "目录前缀应保持 toolOutput 灰");
	assert.doesNotMatch(line, /\[accent\]src\/deep\//, "目录前缀不得被上色");
});

check("U. write 明细行：只提亮文件名，不出现 +a/−r 色段", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);

	const rows = [];
	await invoke(stub, rows, "u1", "write", { path: "log.ts", content: "export const log = 1;\n" }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	assert.equal(data.details[0].text, "✓ 修改 log.ts", "write 没有 diff 统计，text 不应有（+a / −r）");
	const line = expandWith(stub, data).find((l) => l.includes("✓ 修改"));
	assert.ok(line, `应渲染出该明细行：${expandWith(stub, data).join(" | ")}`);
	assert.match(line, /\[accent\]log\.ts\[\/\]/, "文件名应为 accent");
	assert.doesNotMatch(line, /toolDiffAdded|toolDiffRemoved/, "不应凭空出现 +/- 色段");
});

check("V. 其它类别不上色：读取 / 查看行整行仍是 toolOutput", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "plain.txt"), "p\n");
	mkdirSync(join(WORK, "plaindir"), { recursive: true });
	writeFileSync(join(WORK, "v.ts"), "const p = 1;\n");

	const rows = [];
	await invoke(stub, rows, "v1", "read", { path: "plain.txt" }, ctx);
	await invoke(stub, rows, "v2", "ls", { path: "plaindir" }, ctx);
	// 对照组：同一块里的 edit 行必须有色段，证明是「按类别选择」而非整块失效
	await invoke(stub, rows, "v3", "edit", { path: "v.ts", edits: [{ oldText: "const p = 1;", newText: "const p = 2;" }] }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	const expanded = expandWith(stub, data);
	const readLine = expanded.find((l) => l.includes("✓ 读取"));
	const lsLine = expanded.find((l) => l.includes("✓ 查看"));
	assert.ok(readLine && lsLine, `应同时渲染出读取与查看行：${expanded.join(" | ")}`);
	for (const [name, l] of [["读取", readLine], ["查看", lsLine]]) {
		assert.match(l, /^\[toolOutput\]/, `${name}行应以 toolOutput 开头`);
		const inner = l.replace(/^\[toolOutput\]/, "").replace(/\[\/\]$/, "");
		assert.ok(!inner.includes("["), `${name}行应整行单色，不得出现额外色段：${l}`);
		assert.doesNotMatch(l, /\[accent\]|\[toolDiff/, `${name}行不得出现 accent / diff 色段`);
	}
	assert.match(expanded.find((l) => l.includes("✓ 修改")), /\[accent\]v\.ts\[\/\]/, "同块的 edit 行应正常着色");
});

check("W. 失败与省略行不强拆色：整行单色", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);

	const rows = [];
	// 失败的 edit（oldText 匹配不上 → throw）
	await invoke(stub, rows, "w1", "edit", { path: "broken.ts", edits: [{ oldText: "nope", newText: "x" }] }, ctx);
	// 补足 25 个操作，触发省略标记
	for (let i = 1; i <= 24; i++) await invoke(stub, rows, `w-${i}`, "read", { path: `w${i}.txt` }, ctx);
	await flushEvents(stub, "agent_end", ctx);

	const data = stub.entries[0].data;
	const errDetail = data.details.find((d) => d.kind === "err");
	assert.ok(errDetail, "应有失败明细");
	assert.match(errDetail.text, /^✗ 修改 broken\.ts/, `失败行文本：${errDetail.text}`);
	assert.equal(errDetail.segs, undefined, "失败行不得带 segs（保持整行红）");

	const omit = data.details.find((d) => d.kind === "omit");
	assert.ok(omit, "25 个操作应产生省略标记");
	assert.equal(omit.segs, undefined, "省略行不得带 segs");

	const expanded = expandWith(stub, data);
	const errLine = expanded.find((l) => l.includes("✗ 修改"));
	assert.match(errLine, /^\[error\]/, "失败行应以 error 红开头（整行单色）");
	assert.doesNotMatch(errLine, /\[accent\]|\[toolDiff/, "失败行不得被拆色");
	assert.match(expanded.find((l) => l.includes("省略")), /^\[muted\]/, "省略行应为 muted");
});

check("X. 会话恢复后配色仍在（segs 随条目持久化）", async () => {
	const stub = makeStub();
	await (await loadExtension())(stub.pi);
	const ctx = await startSession(stub);
	writeFileSync(join(WORK, "restore.ts"), "const r = 1;\n");

	const rows = [];
	await invoke(stub, rows, "x1", "edit", { path: "restore.ts", edits: [{ oldText: "const r = 1;", newText: "const r = 2;" }] }, ctx);
	await flushEvents(stub, "agent_end", ctx);
	const entry = { type: "custom", customType: stub.entries[0].type, data: stub.entries[0].data };
	// 内存中的 items 已清空，下面完全靠条目数据渲染
	assert.equal(stub.entries[0].data.items.length, 1, "前置条件：条目只存了 items，展开明细靠 details");

	const stub2 = makeStub();
	await (await loadExtension())(stub2.pi);
	await startSession(stub2, [entry]);
	const line = expandWith(stub2, entry.data).find((l) => l.includes("✓ 修改"));
	assert.ok(line, `恢复后应渲染出该明细行：${expandWith(stub2, entry.data).join(" | ")}`);
	assert.match(line, /\[accent\]restore\.ts\[\/\]/, "恢复后文件名仍应上色");
	assert.match(line, /\[toolDiffAdded\]\+1\[\/\]/, "恢复后 +1 仍应为绿");
	assert.match(line, /\[toolDiffRemoved\]−1\[\/\]/, "恢复后 −1 仍应为红");
});

// ---------------------------------------------------------------- run

let failed = 0;
for (const { name, fn } of checks) {
	try {
		await fn();
		console.log(`✓ ${name}`);
	} catch (error) {
		failed++;
		console.log(`✗ ${name}\n  ${error?.message ?? error}`);
	}
}
rmSync(WORK, { recursive: true, force: true });
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
