import { Fragment, memo, useMemo } from "react";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins, type Components } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { createMathPlugin } from "@streamdown/math";
import { MarkdownLink, remarkLinkifyPaths } from "./MarkdownLink";
import { markdownUrlTransform } from "./MarkdownLinkCore";
import { FormulaCopyLayer } from "./FormulaCopyLayer";
import { useSmoothStream } from "../../utils/useSmoothStream";

/**
 * 数学公式插件（KaTeX）。@streamdown/math 默认 singleDollarTextMath: false，
 * 只解析 $$...$$；而 AI 输出行内公式普遍用单美元 $...$（如 $E=mc^2$），
 * 不开则整句原样输出（用户可见的“公式没渲染”）。
 * 开启单美元的安全边界（remark-math 行为）：必须成对的 $...$ 才解析，
 * 单独的 $5、$HOME 等不受影响；副作用是 “$5 and $6” 这类成对美元会被当
 * 行内公式（与 GitHub math 渲染行为一致，可接受）。
 */
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

/**
 * 流式超长兜底阈值（字符数，UTF-16 code unit）。
 *
 * 流式主路径已是纯文本节点；该阈值只防「误走 parse」或异常超长累积。
 * 超过后仍保持纯文本，settle 后再切回全量 Streamdown。正文与思考共用。
 */
export const STREAM_LIGHT_MAX_CHARS = 8_000;

function lastOpenFenceIndex(text: string): number {
	const matches = [...text.matchAll(/```|~~~/g)];
	if (matches.length % 2 === 0) return -1;
	return matches[matches.length - 1]?.index ?? -1;
}

/** 流式未闭合围栏只截到围栏前，避免半截代码/mermaid 触发重解析。 */
function streamingDisplayText(text: string): string {
	const openAt = lastOpenFenceIndex(text);
	if (openAt < 0) return text;
	return text.slice(0, openAt).trimEnd();
}

/**
 * Streamdown 渲染管线（唯一 markdown 引擎）。
 *
 * 内置能力（由 streamdown 官方插件接管，不再自研）：
 * - 代码高亮：@streamdown/code（shiki 3.x JS 引擎 + 按语言懒加载；行号/复制/下载由
 *   streamdown 内置外壳提供，观感由 streamdownChrome.css（utilities 层）压掉官方双层皮；
 *   2026-08 曾因全语言常驻移除，恢复时按 memory-profile 复测）
 * - 数学公式：@streamdown/math（KaTeX，$...$/$$...$$）
 * - mermaid 图表：@streamdown/mermaid（```mermaid 代码块 → 交互式 SVG + 全屏/缩放/下载控件）
 * - 表格：GFM + 内建复制/下载（CSV/TSV/Markdown）控件
 * - HTML 标签：默认 sanitize（未知标签剥属性保留文本）
 *
 * 有意保留的项目能力（streamdown 无对应内置或桌面语义不同）：
 * - a 仍走 MarkdownLink：file:// 本地路径可点击打开、外链经 onOpenExternal
 *   走系统浏览器（linkSafety 内置的「打开」用 window.open，桌面端不可用）；
 *   危险协议（javascript:/data:）由 urlTransform 拦截
 * - cytoscape / wardley 图表：streamdown 只有 mermaid，经 plugins.renderers
 *   注册自定义渲染器保留（见 MarkdownDiagramRenderers）
 *
 * 注：plugins 传参处对第三方边界类型做了收窄（streamdown 官方组合用法）。
 */
export const MarkdownStream = memo(function MarkdownStream(props: {
	text: string;
	isStreaming?: boolean;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
	/** 静态场景（FileDiffViewer/AppUpdateOverlay/ScratchPad）可覆盖默认插件 */
	remarkPlugins?: Parameters<typeof Streamdown>[0]["remarkPlugins"];
	rehypePlugins?: Parameters<typeof Streamdown>[0]["rehypePlugins"];
	urlTransform?: (url: string) => string;
	components?: Parameters<typeof Streamdown>[0]["components"];
	/** 是否禁用图表/代码高亮等重型渲染（静态小场景如更新日志可关以省内存） */
	light?: boolean;
}) {
	const isDark = typeof document !== "undefined" &&
		document.documentElement.dataset.theme === "dark";
	// 逐字打字机：默认约 24ms / 每帧最多 3 个语素，避免 120Hz 全量 parse。
	const { displayedContent } = useSmoothStream({
		content: props.text,
		isStreaming: Boolean(props.isStreaming),
	});
	const displayText = props.isStreaming ? displayedContent : props.text;
	const isStreamingNow = Boolean(props.isStreaming);
	// 流式超长兜底：长度单调递增，一旦超过阈值保持纯文本到 settle，不会反复横跳。
	const streamPlain =
		isStreamingNow && displayText.length > STREAM_LIGHT_MAX_CHARS;
	const streamLive = isStreamingNow;
	const liveText = streamLive && !streamPlain
		? streamingDisplayText(displayText)
		: displayText;
	// 静态场景仍可主动 light（更新日志等）；流式不再挂半套 Streamdown。
	const effectiveLight = props.light || streamLive;
	const resolvedRemarkPlugins = streamLive
		? []
		: (props.remarkPlugins ?? [
				defaultRemarkPlugins.gfm,
				defaultRemarkPlugins.codeMeta,
				remarkLinkifyPaths,
			]);
	const resolvedRehypePlugins = streamLive
		? []
		: (props.rehypePlugins ?? [defaultRehypePlugins.raw]);
	// 显式 Components 标注：让 a 的 props 走上下文类型推断（streamdown 的
	// Components 是「具名槽位 | 索引签名」联合，直接内联会触发索引签名分支的类型不兼容）
	// useMemo 依赖回调 props：回调引用变化时 components 重建，streamElement 随之重建，
	// 闭包不会捕获过期回调（比裸对象 + eslint-disable 的做法依赖链完整）。
	const components: Components = useMemo(
		() =>
			props.components ?? {
				a: (linkProps) => (
					<MarkdownLink
						{...(linkProps as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				),
			},
		[props.components, props.onOpenExternal, props.onOpenFile],
	);
	const streamElement = useMemo(
		() =>
			streamLive ? (
				<div className="whitespace-pre-wrap break-words">{liveText}</div>
			) : (
				<Streamdown
				mode="static"
				isAnimating={false}
				remarkPlugins={resolvedRemarkPlugins}
				rehypePlugins={resolvedRehypePlugins}
				urlTransform={props.urlTransform ?? markdownUrlTransform}
				plugins={
					(effectiveLight
						? { math: mathPlugin }
						: {
								code,
								mermaid,
								math: mathPlugin,
							}) as Parameters<typeof Streamdown>[0]["plugins"]
				}
				mermaid={{
					config: {
						theme: isDark ? "dark" : "default",
						securityLevel: "strict",
					},
				}}
				components={components}
			>
				{displayText}
			</Streamdown>
			),
		[
			displayText,
			streamPlain,
			streamLive,
			liveText,
			components,
			effectiveLight,
			resolvedRemarkPlugins,
			resolvedRehypePlugins,
			props.urlTransform,
			isDark,
		],
	);
	return (
		<Fragment>
			{streamElement}
			<FormulaCopyLayer />
		</Fragment>
	);
});
