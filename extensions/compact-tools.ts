/**
 * compact-tools.ts — 紧凑工具显示 + 请求级工具聚合
 *
 * 覆盖内置工具（read / write / edit / bash / grep / find / ls）的 TUI 渲染：
 *   - 聚合模式（默认）：一次用户请求里的所有工具行都不显示，只在最新一行上留一句
 *     进度；请求结束后在回答下方追加一个「汇总块」（TUI-only，占 0 token）。
 *   - v1 模式（PI_COMPACT_TOOLS_AGGREGATE=0）：一行一个工具，折叠=摘要一行，Ctrl+O 展开。
 *   - 未参与聚合的行（扩展加载前的历史、其它扩展的工具）一律走 v1 紧凑渲染。
 * 对模型上下文的硬保证（改代码时不要破坏）：
 *   - 只注册同名内置工具，不新增工具；不新增 promptSnippet / promptGuidelines；
 *   - execute 原样返回内置定义的结果（同一对象引用），不裁剪、不包装；
 *   - 汇总数据走 pi.appendEntry()（官方定义：不进 LLM 上下文），从不 sendMessage。
 *
 * 实现要点（踩过的坑，改动时请保留）：
 *   1. 注册时 spread createXxxToolDefinition()，而不是 createXxxTool()。
 *      promptSnippet / promptGuidelines / renderShell / prepareArguments /
 *      constrainedSampling 都**不会**从被覆盖的内置工具继承：
 *        - 丢了 promptSnippet → 系统提示的 Available tools 里没有这些工具
 *        - 丢了 promptGuidelines → "Use read to examine files instead of cat or sed."
 *          以及 edit 的 4 条 oldText 匹配规则全部消失
 *        - 丢了 prepareArguments → edit 不再兼容「edits 传成 JSON 字符串 /
 *          单个对象 / 旧版顶层 oldText+newText」的模型与旧会话
 *   2. 执行时按 ctx.cwd + 项目信任重建定义，并透传 settings 里的
 *      shellPath / shellCommandPrefix / imageAutoResize（内置工具会传）。
 *   3. 失败要用 context.isError 判定：内置工具的错误是 throw 出来的，文本不以
 *      "error" 开头；bash 的文案是 "Command exited with code N"。
 *   4. 真正「隐藏」一行：renderShell: "self" + 返回空 Container
 *      （ToolExecutionComponent.render() 会直接返回 []，连 Spacer 都绕过）。
 *   5. grep / find / ls 无结果时返回普通文本（"No matches found" 等），不能按行计数。
 *   6. 运行期（runActive）未登记的行先隐藏，flush 时仍未登记的才恢复成 v1 行：
 *      否则「被其它扩展在 tool_call 阶段拦下」的工具会整行消失。
 *   7. session_shutdown 只 flush、**不** reset：/reload 后旧行仍绑定旧实例的渲染器
 *      闭包，reset 会让它们重新变成可见的 v1 行。reset 只在 session_start 做。
 *   8. HTML 导出是另一条渲染路径：模板对 bash/read/write/edit/ls 用自带结构化渲染
 *      （不调本扩展渲染器），只有 grep/find 走扩展渲染，且自定义条目不导出——
 *      所以不要为了「导出好看」往隐藏行里塞内容。
 *
 * 安装：pi install git:github.com/lucissie-dot/pi-compact-tool-cards@v0.1.0
 *       （或把本文件复制到 ~/.pi/agent/extensions/）
 * 生效方式：/reload（或重启 pi）
 * 说明文档：同目录 compact-tools.md（效果、可调项、维护须知、自测脚本）
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";

// ------------------------------------------------------------------ 配置

/** 汇总条目的 customType（写进 session 文件，勿随意改） */
const ENTRY_TYPE = "compact-tools.group";

/** 聚合模式；PI_COMPACT_TOOLS_AGGREGATE=0 时退回 v1「一行一个工具」 */
const AGGREGATE = process.env.PI_COMPACT_TOOLS_AGGREGATE !== "0";

/** 展开时最多显示多少行（v1 模式的内容/diff 预览） */
const EXPANDED_LIMIT = 30;
/** 汇总块第 2 行最多列几个被修改的文件名 */
const MODIFIED_NAME_MAX = 5;
/** 明细展示上限；超出时保留首 DETAIL_HEAD 项 + 末 DETAIL_TAIL 项（最早与最新的操作都不丢） */
const DETAIL_HEAD = 5;
const DETAIL_TAIL = 15;
const DETAIL_MAX = DETAIL_HEAD + DETAIL_TAIL;
/** 进度行里命令/标签的最大字符数 */
const LABEL_MAX = 40;

const TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

// ------------------------------------------------------------------ 聚合数据模型

type Cat = "edit" | "read" | "list" | "cmd" | "search";
type Status = "run" | "ok" | "err" | "abort";

/** 一次工具调用 */
type Item = {
	/** toolCallId（用于会话恢复后把旧行映射回它所属的组） */
	id: string;
	cat: Cat;
	tool: string;
	status: Status;
	/** 展示用短标签：文件名 / pattern / 命令前 N 字 */
	label: string;
	/** 参数里的原始路径（write/edit/read/ls），用于汇总时还原相对路径 */
	rawPath?: string;
	/** 失败/中断原因（一行，已截断到 200 字） */
	errText?: string;
	/** edit 的 diff 统计，如 "+12 / −4" */
	stat?: string;
};

type LineKind = "title" | "files" | "warn";
type Line = { text: string; kind: LineKind };
type DetailKind = "ok" | "err" | "abort" | "omit";
type Detail = { text: string; kind: DetailKind };

/** 写进 session 的汇总条目（不进模型上下文） */
type EntryData = {
	/** v1 = 旧格式（只存全量 items）；v2 = 增加 ids，items 只留首 DETAIL_HEAD + 末 DETAIL_TAIL 项。读取时两者都接受 */
	v: 1 | 2;
	id: string;
	lines: Line[];
	details: Detail[];
	/** 明细总数（details 已按 DETAIL_MAX 截断） */
	detailTotal: number;
	hasError: boolean;
	/** v2：本次请求全部 toolCallId，会话恢复时用于隐藏对应的工具行 */
	ids?: string[];
	/** 明细用到的首 DETAIL_HEAD + 末 DETAIL_TAIL 项（按发生顺序；id = toolCallId） */
	items?: Item[];
};

/** 内存中的组（open = 正在进行的请求） */
type Group = {
	id: string;
	items: Item[];
	status: "open" | "flushed";
	/** 当前用于渲染进度行的那一行（最近一次工具调用） */
	carrierId?: string;
	/** carrier 行的 invalidate()，用于让进度行重绘 */
	invalidate?: () => void;
	lines?: Line[];
	details?: Detail[];
	detailTotal?: number;
	hasError?: boolean;
};

const CAT_OF: Record<string, Cat> = {
	read: "read",
	ls: "list",
	grep: "search",
	find: "search",
	bash: "cmd",
	write: "edit",
	edit: "edit",
};
const CAT_ORDER: Cat[] = ["edit", "read", "list", "cmd", "search"];
const CAT_ICON: Record<Cat, string> = { edit: "✏️", read: "📖", list: "📂", cmd: "💻", search: "🔍" };
const CAT_VERB: Record<Cat, string> = { edit: "修改", read: "读取", list: "查看", cmd: "执行命令", search: "搜索" };
const CAT_LABEL: Record<Cat, (n: number) => string> = {
	edit: (n) => `修改 ${n} 个文件`,
	read: (n) => `读取 ${n} 个文件`,
	list: (n) => `查看 ${n} 个目录`,
	cmd: (n) => `执行 ${n} 条命令`,
	search: (n) => `搜索 ${n} 次`,
};

// ------------------------------------------------------------------ 业务定义（与内置工具一致）

type Defs = {
	read: ReturnType<typeof createReadToolDefinition>;
	bash: ReturnType<typeof createBashToolDefinition>;
	edit: ReturnType<typeof createEditToolDefinition>;
	write: ReturnType<typeof createWriteToolDefinition>;
	grep: ReturnType<typeof createGrepToolDefinition>;
	find: ReturnType<typeof createFindToolDefinition>;
	ls: ReturnType<typeof createLsToolDefinition>;
};

const cache = new Map<string, Defs>();

/** 构造与内置工具行为一致的定义；按 cwd + 项目信任缓存，并透传 settings */
function defsFor(cwd: string, projectTrusted: boolean): Defs {
	const key = `${cwd}\u0000${projectTrusted}`;
	let d = cache.get(key);
	if (!d) {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
		d = {
			read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
			bash: createBashToolDefinition(cwd, {
				commandPrefix: settings.getShellCommandPrefix(),
				shellPath: settings.getShellPath(),
			}),
			edit: createEditToolDefinition(cwd),
			write: createWriteToolDefinition(cwd),
			grep: createGrepToolDefinition(cwd),
			find: createFindToolDefinition(cwd),
			ls: createLsToolDefinition(cwd),
		};
		cache.set(key, d);
	}
	return d;
}

/** 仅用于注册时的元数据（description / parameters / promptSnippet 等与 options 无关） */
function meta(cwd: string): Defs {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

// ------------------------------------------------------------------ 纯文本工具

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function shortenPath(p: unknown): string {
	const s = str(p);
	if (!s) return "";
	const home = homedir();
	return s.startsWith(home) ? `~${s.slice(home.length)}` : s;
}

/** 路径参数（兼容旧会话里的 file_path 别名） */
function argPath(args: any): string {
	return shortenPath(args?.file_path ?? args?.path) || "…";
}

function firstText(result: any): string {
	const list = result?.content;
	if (!Array.isArray(list)) return "";
	const hit = list.find((c: any) => c?.type === "text");
	return hit && typeof hit.text === "string" ? hit.text : "";
}

function hasImage(result: any): boolean {
	const list = result?.content;
	return Array.isArray(list) && list.some((c: any) => c?.type === "image");
}

/** 取前 n 行（去掉首尾空白） */
function takeLines(text: string, n: number): string {
	return text.trim().split("\n").slice(0, n).join("\n");
}

/** 若超出 n 行，返回剩余行数提示 */
function moreNote(text: string, n: number): string {
	const total = text.trim().split("\n").length;
	return total > n ? `\n... 还有 ${total - n} 行` : "";
}

function countLines(text: string, nonEmptyOnly = false): number {
	const lines = text.trim().split("\n");
	return nonEmptyOnly ? lines.filter((l) => l.trim()).length : lines.length;
}

/** 最后一条非空行，用于把错误摘要压成一行 */
function lastLine(text: string): string {
	const lines = text.trim().split("\n").filter((l) => l.trim());
	return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * read 会在结尾追加截断/续读提示，统计行数时应剔除。
 * 只匹配内置 read 真正会追加的两类尾部提示，避免把 `[section]`、`[1, 2]` 这类合法尾行也删掉：
 *   [Showing lines 1-200 of 900. Use offset=201 to continue.]
 *   [Showing lines 1-200 of 900 (12KB limit). Use offset=201 to continue.]
 *   [37 more lines in file. Use offset=201 to continue.]
 * （`[Line N is X, exceeds ... limit. Use bash: ...]` 是整段输出、无前导换行，不会命中。）
 */
const READ_NOTICE_RE =
	/^\[(?:Showing lines \d+-\d+ of \d+(?: \([^)]+\))?\. Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]$/;
function stripReadNotices(text: string): string {
	let out = text.trimEnd();
	let idx = out.lastIndexOf("\n");
	while (idx >= 0 && READ_NOTICE_RE.test(out.slice(idx + 1))) {
		out = out.slice(0, idx).trimEnd();
		idx = out.lastIndexOf("\n");
	}
	return out;
}

/** diff 的 +/− 行数统计 */
function diffStat(diff: string): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return `+${added} / −${removed}`;
}

function truncationNote(result: any, theme: any): string {
	const t = result?.details?.truncation;
	if (!t?.truncated) return result?.details?.fullOutputPath ? theme.fg("warning", " [截断]") : "";
	return theme.fg("warning", " [截断]");
}

/** 绝对路径 → cwd 相对路径（不可用时回退为原样，分隔符统一为 /） */
function relPath(cwd: string, p: string): string {
	if (!p) return "";
	try {
		const abs = isAbsolute(p) ? p : resolvePath(cwd, p);
		const rel = relative(cwd, abs);
		if (!rel || rel.startsWith("..")) return p.replace(/\\/g, "/");
		return rel.replace(/\\/g, "/");
	} catch {
		return p.replace(/\\/g, "/");
	}
}

// ------------------------------------------------------------------ 组件构造

function emptyRow(): Container {
	return new Container();
}

function bgKeyFor(context: any): string {
	if (context?.isError) return "toolErrorBg";
	if (context?.isPartial) return "toolPendingBg";
	return "toolSuccessBg";
}

/** 一行进度（聚合进行中，只在最新一次工具调用的那一行上显示） */
function progressRow(group: Group, theme: any): Container {
	// 优先指向最新一个仍在运行的项（并行调用时旧的会先跑完）；全部跑完时指向最后一项
	const cur = group.items.findLast((i) => i.status === "run") ?? group.items[group.items.length - 1];
	const text =
		theme.fg("warning", `⏳ 处理中 ${group.items.length} 个操作`) +
		theme.fg("dim", " · 最新：") +
		theme.fg("accent", `${CAT_ICON[cur.cat]} ${CAT_VERB[cur.cat]} ${cur.label}`);
	const box = new Box(1, 1, (t: string) => theme.bg("toolPendingBg", t));
	box.addChild(new TruncatedText(text, 0, 0));
	return box;
}

/** 汇总块本身（entry 渲染与 carrier 回退渲染共用）；省略信息已编码进 details 的 "omit" 项 */
function summaryBox(theme: any, lines: Line[], details: Detail[] | undefined, hasError: boolean): Box {
	const box = new Box(1, 1, (t: string) => theme.bg(hasError ? "toolErrorBg" : "toolSuccessBg", t));
	for (const line of lines) {
		const color = line.kind === "title" ? "toolTitle" : line.kind === "files" ? "accent" : "warning";
		box.addChild(new TruncatedText(theme.fg(color, line.text), 0, 0));
	}
	if (details && details.length > 0) {
		for (const d of details) {
			const color = d.kind === "err" ? "error" : d.kind === "abort" ? "warning" : d.kind === "omit" ? "muted" : "toolOutput";
			box.addChild(new Text(theme.fg(color, d.text), 0, 0));
		}
	}
	return box;
}

// ------------------------------------------------------------------ 汇总文本

function describe(tool: string, params: any): { cat: Cat; label: string; rawPath?: string } {
	const cat = CAT_OF[tool] ?? "read";
	if (tool === "bash") return { cat, label: clip(str(params?.command), LABEL_MAX) || "…" };
	if (tool === "grep") return { cat, label: `/${str(params?.pattern)}/` };
	if (tool === "find") return { cat, label: str(params?.pattern) || "…" };
	const raw = str(params?.file_path ?? params?.path);
	if (tool === "ls") return { cat, label: raw ? basename(raw) : ".", rawPath: raw || undefined };
	return { cat, label: raw ? basename(raw) : "…", rawPath: raw || undefined };
}

/** 被修改文件名的展示：去重、同名冲突时退化为相对路径 */
function displayNames(items: Item[], cwd: string): string[] {
	const seen = new Set<string>();
	const uniq: { key: string; name: string }[] = [];
	for (const it of items) {
		const key = it.rawPath ? (isAbsolute(it.rawPath) ? it.rawPath : resolvePath(cwd, it.rawPath)) : it.label;
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push({ key, name: basename(key) || it.label });
	}
	const counts = new Map<string, number>();
	for (const u of uniq) counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
	return uniq.map((u) => ((counts.get(u.name) ?? 0) > 1 ? relPath(cwd, u.key) : u.name));
}

function buildSummary(items: Item[], cwd: string): { lines: Line[]; details: Detail[]; detailTotal: number; hasError: boolean } {
	const counts = Object.fromEntries(CAT_ORDER.map((c) => [c, 0])) as Record<Cat, number>;
	for (const it of items) counts[it.cat]++;

	const parts: string[] = [];
	for (const cat of CAT_ORDER) {
		if (counts[cat] > 0) parts.push(`${CAT_ICON[cat]} ${CAT_LABEL[cat](counts[cat])}`);
	}
	const lines: Line[] = [{ kind: "title", text: `🔧 本次 ${items.length} 个操作：${parts.join(" · ")}` }];

	const modified = items.filter((it) => it.cat === "edit");
	if (modified.length > 0) {
		const names = displayNames(modified, cwd);
		const shown = names.slice(0, MODIFIED_NAME_MAX).join("、");
		const suffix = names.length > MODIFIED_NAME_MAX ? ` 等 ${names.length} 个文件` : "";
		lines.push({ kind: "files", text: `📝 ${shown}${suffix}` });
	}

	const failed = items.filter((it) => it.status === "err");
	const aborted = items.filter((it) => it.status === "abort");
	if (failed.length > 0 || aborted.length > 0) {
		const notices: string[] = [];
		if (failed.length > 0) notices.push(`${failed.length} 个操作失败：${clip(failed[0].errText ?? "", 60)}`);
		if (aborted.length > 0) notices.push(`${aborted.length} 个操作中断`);
		lines.push({ kind: "warn", text: `⚠️ ${notices.join(" · ")}` });
	}

	const render = (it: Item): Detail => {
		const kind: DetailKind = it.status === "abort" ? "abort" : it.status === "err" ? "err" : "ok";
		const prefix = kind === "ok" ? "✓" : kind === "abort" ? "⚠️" : "✗";
		const where = it.rawPath ? relPath(cwd, it.rawPath) : it.label;
		const stat = it.stat ? `（${it.stat}）` : "";
		const note = it.errText ? `  ${clip(it.errText, 80)}` : "";
		return { kind, text: `${prefix} ${CAT_VERB[it.cat]} ${where}${stat}${note}` };
	};
	// 首尾兼顾：大请求里最早与最新发生的操作都不丢，中间用 omit 标记
	const omitted = Math.max(0, items.length - DETAIL_MAX);
	const details: Detail[] =
		omitted === 0
			? items.map(render)
			: [
					...items.slice(0, DETAIL_HEAD).map(render),
					{ kind: "omit", text: `… 省略 ${omitted} 项 …` },
					...items.slice(items.length - DETAIL_TAIL).map(render),
				];

	return { lines, details, detailTotal: items.length, hasError: failed.length + aborted.length > 0 };
}

/** session 条目里保存的 items：与展开明细一致，保留首 DETAIL_HEAD + 末 DETAIL_TAIL 项 */
function pickEntryItems(items: Item[]): Item[] {
	if (items.length <= DETAIL_MAX) return items;
	return [...items.slice(0, DETAIL_HEAD), ...items.slice(items.length - DETAIL_TAIL)];
}

// ------------------------------------------------------------------ v1 紧凑渲染（未参与聚合的行）

type V1 = {
	call: (args: any, theme: any) => string;
	result: (result: any, options: any, theme: any, context: any) => string;
};

function v1ReadCall(args: any, theme: any): string {
	let text = theme.fg("toolTitle", theme.bold("read "));
	text += theme.fg("accent", argPath(args));
	if (args?.offset || args?.limit) {
		const parts: string[] = [];
		if (args.offset) parts.push(`offset=${args.offset}`);
		if (args.limit) parts.push(`limit=${args.limit}`);
		text += theme.fg("dim", ` (${parts.join(", ")})`);
	}
	return text;
}

function v1ReadResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "读取中…");
	if (context.isError) return theme.fg("error", `✗ ${lastLine(firstText(result)) || "读取失败"}`);
	if (hasImage(result)) return theme.fg("success", "✓ 图片");

	const content = firstText(result);
	if (!content.trim()) return theme.fg("muted", "（空）");

	const body = stripReadNotices(content);
	let text = theme.fg("success", `✓ ${countLines(body || content)} 行`);
	if (result?.details?.truncation?.truncated) text += theme.fg("warning", "（已截断）");
	if (expanded) {
		text += `\n${theme.fg("dim", takeLines(content, EXPANDED_LIMIT))}`;
		text += theme.fg("muted", moreNote(content, EXPANDED_LIMIT));
	}
	return text;
}

function v1BashCall(args: any, theme: any): string {
	const cmd = str(args?.command);
	let text = theme.fg("toolTitle", theme.bold("$ "));
	text += theme.fg("accent", clip(cmd, 100) || "…");
	if (args?.timeout) text += theme.fg("dim", ` (timeout ${args.timeout}s)`);
	return text;
}

function v1BashResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "运行中…");
	const out = firstText(result);
	const lines = countLines(out, true);
	let text = context.isError
		? theme.fg("error", `✗ ${lastLine(out) || "命令失败"}`)
		: theme.fg("success", "✓ done");
	if (lines > 0) text += theme.fg("dim", ` · ${lines} 行`);
	text += truncationNote(result, theme);
	if (expanded && out.trim()) {
		text += `\n${theme.fg("dim", takeLines(out, EXPANDED_LIMIT))}`;
		text += theme.fg("muted", moreNote(out, EXPANDED_LIMIT));
	}
	return text;
}

function v1WriteCall(args: any, theme: any): string {
	const lines = typeof args?.content === "string" ? countLines(args.content) : 0;
	let text = theme.fg("toolTitle", theme.bold("write "));
	text += theme.fg("accent", argPath(args));
	if (lines > 0) text += theme.fg("dim", ` (${lines} 行)`);
	return text;
}

function v1WriteResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "写入中…");
	const text = firstText(result);
	if (context.isError) return theme.fg("error", `✗ ${lastLine(text) || "写入失败"} `);
	let out = theme.fg("success", "✓ 已写入");
	if (expanded && text.trim()) out += `\n${theme.fg("dim", takeLines(text, EXPANDED_LIMIT))}`;
	return out;
}

function v1EditCall(args: any, theme: any): string {
	let text = theme.fg("toolTitle", theme.bold("edit "));
	text += theme.fg("accent", argPath(args));
	const n = Array.isArray(args?.edits) ? args.edits.length : 0;
	if (n > 1) text += theme.fg("dim", ` (${n} 处)`);
	return text;
}

function v1EditResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "编辑中…");
	const text = firstText(result);
	if (context.isError) return theme.fg("error", `✗ ${lastLine(text) || "编辑失败"}`);

	const diff: string | undefined = result?.details?.diff;
	if (!diff) return theme.fg("success", "✓ 已应用");

	const diffLines = diff.split("\n");
	let added = 0;
	let removed = 0;
	for (const line of diffLines) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	let out = theme.fg("success", `+${added}`) + theme.fg("dim", " / ") + theme.fg("error", `−${removed}`);
	if (expanded) {
		for (const line of diffLines.slice(0, EXPANDED_LIMIT)) {
			if (line.startsWith("+") && !line.startsWith("+++")) out += `\n${theme.fg("success", line)}`;
			else if (line.startsWith("-") && !line.startsWith("---")) out += `\n${theme.fg("error", line)}`;
			else out += `\n${theme.fg("dim", line)}`;
		}
		if (diffLines.length > EXPANDED_LIMIT) {
			out += `\n${theme.fg("muted", `... 还有 ${diffLines.length - EXPANDED_LIMIT} 行`)}`;
		}
	}
	return out;
}

function v1GrepCall(args: any, theme: any): string {
	let text = theme.fg("toolTitle", theme.bold("grep "));
	text += theme.fg("accent", `/${str(args?.pattern)}/`);
	text += theme.fg("dim", ` · ${shortenPath(args?.path) || "."}`);
	if (args?.glob) text += theme.fg("dim", ` (${args.glob})`);
	return text;
}

function v1GrepResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "搜索中…");
	const out = firstText(result);
	if (context.isError) return theme.fg("error", `✗ ${lastLine(out) || "搜索失败"}`);
	// 无结果时内置工具返回 "No matches found"，不能按行数当匹配数
	const empty = !out.trim() || /^No matches found$/i.test(out.trim());
	const n = empty ? 0 : countLines(out, true);
	let text = n > 0 ? theme.fg("success", `✓ ${n} 处匹配`) : theme.fg("muted", "无匹配");
	text += truncationNote(result, theme);
	if (expanded && n > 0) {
		text += `\n${theme.fg("dim", takeLines(out, EXPANDED_LIMIT))}`;
		text += theme.fg("muted", moreNote(out, EXPANDED_LIMIT));
	}
	return text;
}

function v1FindCall(args: any, theme: any): string {
	let text = theme.fg("toolTitle", theme.bold("find "));
	text += theme.fg("accent", str(args?.pattern));
	text += theme.fg("dim", ` · ${shortenPath(args?.path) || "."}`);
	return text;
}

function v1FindResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "查找中…");
	const out = firstText(result);
	if (context.isError) return theme.fg("error", `✗ ${lastLine(out) || "查找失败"}`);
	const empty = !out.trim() || /^No files found matching pattern$/i.test(out.trim());
	const n = empty ? 0 : countLines(out, true);
	let text = n > 0 ? theme.fg("success", `✓ ${n} 个文件`) : theme.fg("muted", "无结果");
	text += truncationNote(result, theme);
	if (expanded && n > 0) {
		text += `\n${theme.fg("dim", takeLines(out, EXPANDED_LIMIT))}`;
		text += theme.fg("muted", moreNote(out, EXPANDED_LIMIT));
	}
	return text;
}

function v1LsCall(args: any, theme: any): string {
	let text = theme.fg("toolTitle", theme.bold("ls "));
	text += theme.fg("accent", shortenPath(args?.path) || ".");
	return text;
}

function v1LsResult(result: any, { expanded, isPartial }: any, theme: any, context: any): string {
	if (isPartial) return theme.fg("warning", "读取中…");
	const out = firstText(result);
	if (context.isError) return theme.fg("error", `✗ ${lastLine(out) || "读取失败"}`);
	const empty = !out.trim() || /^\(empty directory\)$/i.test(out.trim());
	const n = empty ? 0 : countLines(out, true);
	let text = n > 0 ? theme.fg("success", `✓ ${n} 项`) : theme.fg("muted", "（空）");
	text += truncationNote(result, theme);
	if (expanded && n > 0) {
		text += `\n${theme.fg("dim", takeLines(out, EXPANDED_LIMIT))}`;
		text += theme.fg("muted", moreNote(out, EXPANDED_LIMIT));
	}
	return text;
}

const V1: Record<ToolName, V1> = {
	read: { call: v1ReadCall, result: v1ReadResult },
	write: { call: v1WriteCall, result: v1WriteResult },
	edit: { call: v1EditCall, result: v1EditResult },
	bash: { call: v1BashCall, result: v1BashResult },
	grep: { call: v1GrepCall, result: v1GrepResult },
	find: { call: v1FindCall, result: v1FindResult },
	ls: { call: v1LsCall, result: v1LsResult },
};

// ------------------------------------------------------------------ 插件

export default function (pi: ExtensionAPI) {
	const boot = meta(process.cwd());

	// ---------------- 聚合状态（每个 session 重置）
	let current: Group | undefined;
	const groups = new Map<string, Group>();
	/** toolCallId → groupId（恢复会话时由条目重建，用于隐藏对应的工具行） */
	const roles = new Map<string, string>();
	const rowInvalidate = new Map<string, () => void>();
	/** 本轮请求是否正在进行（用于消除「流式中先闪一下 v1 行」） */
	let runActive = false;
	/** 运行期被隐藏、但尚未登记进组的行（可能是被其它扩展拦下、永不执行的行） */
	const pendingOrphans = new Set<string>();
	/** flush 时确认永远不会登记的行：永久退回 v1 紧凑行，避免整行消失 */
	const visibleOrphans = new Set<string>();
	let lastCwd = process.cwd();

	const canRenderEntries = typeof (pi as any).registerEntryRenderer === "function";
	const canAppendEntries = typeof (pi as any).appendEntry === "function";

	if (canRenderEntries) {
		pi.registerEntryRenderer<EntryData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
			const data = entry.data;
			if (!data || !Array.isArray(data.lines) || data.lines.length === 0) return undefined;
			return summaryBox(theme, data.lines, expanded ? data.details : undefined, !!data.hasError);
		});
	}

	function newGroup(): Group {
		const g: Group = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, items: [], status: "open" };
		groups.set(g.id, g);
		current = g;
		return g;
	}

	/** 工具开始：登记 item，并把「显示进度行」的那一行切换到本次调用 */
	function begin(tool: ToolName, toolCallId: string, params: any, cwd?: string): Item | undefined {
		if (!AGGREGATE) return undefined;
		if (cwd) lastCwd = cwd;
		const group = current ?? newGroup();
		const d = describe(tool, params);
		const item: Item = { id: toolCallId, cat: d.cat, tool, status: "run", label: d.label, rawPath: d.rawPath };
		group.items.push(item);
		roles.set(toolCallId, group.id);
		pendingOrphans.delete(toolCallId); // 已登记，不再需要兜底
		visibleOrphans.delete(toolCallId); // 极端时序（flush 后才开始执行）下也要收回到聚合里

		const prev = group.invalidate;
		group.carrierId = toolCallId;
		group.invalidate = undefined;
		if (prev) prev(); // 上一行退回隐藏
		rowInvalidate.get(toolCallId)?.(); // 本行由「未聚合」变为「进度行」
		return item;
	}

	function touch(): void {
		current?.invalidate?.();
	}

	function finish(item: Item | undefined, result: any): void {
		// 已 flush（用户中断等）的项目不再改写，避免污染已写入 session 的汇总
		if (!item || item.status !== "run") return;
		item.status = "ok";
		const diff = result?.details?.diff;
		if (typeof diff === "string") item.stat = diffStat(diff);
		touch();
	}

	function fail(item: Item | undefined, err: unknown): void {
		if (!item || item.status !== "run") return;
		item.status = "err";
		item.errText = clip(lastLine(err instanceof Error ? err.message : String(err ?? "")), 200) || "执行失败";
		touch();
	}

	/** 请求结束：释放未登记的孤儿行 + 把这一轮的工具调用写成一条 session 条目 */
	function flush(cwd?: string): void {
		runActive = false;
		// 运行期被隐藏、却始终没有登记的行（例如被其它扩展在 tool_call 阶段拦下）→ 恢复成 v1 行
		for (const id of pendingOrphans) {
			if (roles.has(id)) continue;
			visibleOrphans.add(id);
			rowInvalidate.get(id)?.();
			rowInvalidate.delete(id); // 释放对旧组件闭包的强引用
		}
		pendingOrphans.clear();

		const group = current;
		current = undefined;
		if (!group || group.items.length === 0) return;

		for (const it of group.items) {
			if (it.status === "run") {
				it.status = "abort";
				it.errText = "已中断";
			}
		}
		const sum = buildSummary(group.items, cwd || lastCwd);
		group.status = "flushed";
		group.lines = sum.lines;
		group.details = sum.details;
		group.detailTotal = sum.detailTotal;
		group.hasError = sum.hasError;

		const flushedIds = group.items.map((it) => it.id);
		if (canAppendEntries) {
			try {
				pi.appendEntry<EntryData>(ENTRY_TYPE, {
					v: 2,
					id: group.id,
					// 写副本：与内存中的活对象解耦，之后任何变更都不得影响已落盘的数据
					ids: flushedIds,
					items: pickEntryItems(group.items).map((it) => ({ ...it })),
					lines: sum.lines.map((l) => ({ ...l })),
					details: sum.details.map((d) => ({ ...d })),
					detailTotal: sum.detailTotal,
					hasError: sum.hasError,
				});
			} catch {
				// 持久化失败不影响 TUI（carrier 行仍会显示汇总）
			}
		}

		// 已 flush 的组不再渲染进度行、也不再读取 items；释放内存（长会话否则线性增长）
		group.items.length = 0;
		for (const id of flushedIds) rowInvalidate.delete(id);

		const invalidate = group.invalidate;
		group.invalidate = undefined;
		if (invalidate) invalidate(); // carrier 行：隐藏（entry 渲染）或改画汇总块（回退）
	}

	// ---------------- 行角色

	type Row = { mode: "hidden" } | { mode: "carrier"; group: Group } | { mode: "summary"; group: Group } | { mode: "fallback" };

	function resolveRow(toolCallId: string): Row {
		if (visibleOrphans.has(toolCallId)) return { mode: "fallback" };
		const groupId = roles.get(toolCallId);
		if (groupId === undefined) {
			// 运行期的行会先于 execute（登记）出现：先隐藏，避免闪一下 v1 样式。
			// 若到 flush 仍然没登记（被拦下/未执行），则由 flush 释放回 v1 行。
			if (AGGREGATE && runActive) {
				pendingOrphans.add(toolCallId);
				return { mode: "hidden" };
			}
			return { mode: "fallback" };
		}
		const group = groups.get(groupId);
		if (!group) return { mode: "hidden" };
		if (group.status === "open") {
			return group.carrierId === toolCallId ? { mode: "carrier", group } : { mode: "hidden" };
		}
		// 已结束：正常由 entry 渲染汇总块；没有 entry 渲染器时让 carrier 行自己画
		if (!canRenderEntries && group.carrierId === toolCallId) return { mode: "summary", group };
		return { mode: "hidden" };
	}

	/** 未参与聚合的行：沿用 v1 紧凑渲染，call/result 共用一个带背景的 Box */
	type FallbackState = { box?: Box; call?: Text; result?: Text; bgKey: string };

	function fallbackSlot(slot: "call" | "result", theme: any, context: any, callText: () => string, resultText: () => string): Container | Box {
		const st: FallbackState = context.state;
		if (!st.box || !st.call || !st.result) {
			st.bgKey = "toolSuccessBg";
			st.box = new Box(1, 1, (t: string) => theme.bg(st.bgKey, t));
			st.call = new Text("", 0, 0);
			st.result = new Text("", 0, 0);
			st.box.addChild(st.call);
			st.box.addChild(st.result);
		}
		st.bgKey = bgKeyFor(context);
		st.box.setBgFn((t: string) => theme.bg(st.bgKey, t));
		if (slot === "call") {
			st.call.setText(callText());
			return st.box;
		}
		st.result.setText(resultText());
		st.box.invalidate();
		return emptyRow();
	}

	function makeRenderers(tool: ToolName) {
		const v1 = V1[tool];
		return {
			renderCall(args: any, theme: any, context: any) {
				rowInvalidate.set(context.toolCallId, context.invalidate);
				const row = resolveRow(context.toolCallId);
				if (row.mode === "hidden") return emptyRow();
				if (row.mode === "carrier") {
					row.group.invalidate = context.invalidate;
					return progressRow(row.group, theme);
				}
				if (row.mode === "summary") {
					return summaryBox(theme, row.group.lines ?? [], context.expanded ? row.group.details : undefined, !!row.group.hasError);
				}
				return fallbackSlot("call", theme, context, () => v1.call(args, theme), () => "");
			},

			renderResult(result: any, options: any, theme: any, context: any) {
				rowInvalidate.set(context.toolCallId, context.invalidate);
				const row = resolveRow(context.toolCallId);
				// 进度行画在 call 槽；汇总块由 entry 或 call 槽负责，这里只需要空行
				if (row.mode !== "fallback") return emptyRow();
				return fallbackSlot("result", theme, context, () => "", () => v1.result(result, options, theme, context));
			},
		};
	}

	// ---------------- 会话生命周期

	function reset(): void {
		current = undefined;
		runActive = false;
		pendingOrphans.clear();
		visibleOrphans.clear();
		groups.clear();
		roles.clear();
		rowInvalidate.clear();
	}

	/** 从条目里收集合法 toolCallId（v2 用 ids；v1 从 items 推导，并校验 cat） */
	function collectIds(data: EntryData): string[] {
		const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
		if (Array.isArray(data.ids)) return data.ids.filter(isId);
		if (!Array.isArray(data.items)) return [];
		const out: string[] = [];
		for (const it of data.items) {
			if (!it || !isId(it.id)) continue;
			if (!CAT_ORDER.includes(it.cat)) continue;
			out.push(it.id);
		}
		return out;
	}

	pi.on("session_start", async (_event, ctx) => {
		reset();
		lastCwd = ctx.cwd;
		if (!ctx.sessionManager) return;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as EntryData | undefined;
			if (!data || (data.v !== 1 && data.v !== 2)) continue;
			const lines = Array.isArray(data.lines) ? data.lines : [];
			if (lines.length === 0) continue;
			const group: Group = {
				id: typeof data.id === "string" && data.id ? data.id : `restored-${groups.size}`,
				items: [], // 已 flush 的组不再渲染进度行，items 只为 live 组服务
				status: "flushed",
				lines,
				details: Array.isArray(data.details) ? data.details : [],
				detailTotal: typeof data.detailTotal === "number" ? data.detailTotal : lines.length,
				hasError: !!data.hasError,
			};
			groups.set(group.id, group);
			for (const id of collectIds(data)) roles.set(id, group.id);
		}
	});

	pi.on("agent_start", () => {
		runActive = true;
		pendingOrphans.clear();
	});
	pi.on("agent_end", (_event, ctx) => flush(ctx?.cwd));
	pi.on("agent_settled", (_event, ctx) => flush(ctx?.cwd));
	// 注意：session_shutdown 只 flush，**不要** reset ——
	// /reload 后旧行的渲染器仍绑定旧实例，reset 会让它们重新变成可见的 v1 行
	pi.on("session_shutdown", (_event, ctx) => flush(ctx?.cwd));

	// ---------------- 工具注册

	/** 统一的执行包装：登记 → 委托内置实现 → 记录结果；返回值原样透传 */
	async function run<T>(tool: ToolName, toolCallId: string, params: any, ctx: any, exec: () => Promise<T>): Promise<T> {
		const item = begin(tool, toolCallId, params, ctx?.cwd);
		try {
			const result = await exec();
			finish(item, result);
			return result;
		} catch (err) {
			fail(item, err);
			throw err;
		}
	}

	/** 取会话作用域；旧版 pi 或特殊模式若缺字段则回落，避免把全部工具一起打挂 */
	function scopeOf(ctx: any): { cwd: string; trusted: boolean } {
		const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
		const trusted = typeof ctx?.isProjectTrusted === "function" ? !!ctx.isProjectTrusted() : true;
		return { cwd, trusted };
	}

	/** 生成某个工具的 execute：透传 settings → 委托内置实现 → 原样返回结果 */
	function execWith(tool: ToolName) {
		return async (toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any): Promise<any> => {
			const { cwd, trusted } = scopeOf(ctx);
			const def = defsFor(cwd, trusted)[tool] as { execute: (...args: any[]) => Promise<any> };
			return run(tool, toolCallId, params, ctx, () => def.execute(toolCallId, params, signal, onUpdate, ctx));
		};
	}

	pi.registerTool({
		...boot.read,
		renderShell: "self",
		execute: execWith("read"),
		...makeRenderers("read"),
	});

	pi.registerTool({
		...boot.bash,
		renderShell: "self",
		execute: execWith("bash"),
		...makeRenderers("bash"),
	});

	pi.registerTool({
		...boot.write,
		renderShell: "self",
		execute: execWith("write"),
		...makeRenderers("write"),
	});

	pi.registerTool({
		...boot.edit, // 自带 prepareArguments；renderShell 已是 "self"
		execute: execWith("edit"),
		...makeRenderers("edit"),
	});

	pi.registerTool({
		...boot.grep,
		renderShell: "self",
		execute: execWith("grep"),
		...makeRenderers("grep"),
	});

	pi.registerTool({
		...boot.find,
		renderShell: "self",
		execute: execWith("find"),
		...makeRenderers("find"),
	});

	pi.registerTool({
		...boot.ls,
		renderShell: "self",
		execute: execWith("ls"),
		...makeRenderers("ls"),
	});
}
