import { memo, useMemo } from "react";
import {
	Streamdown,
	defaultRehypePlugins,
	defaultRemarkPlugins,
	type Components,
	type StreamdownProps,
} from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { createMathPlugin } from "@streamdown/math";
import remarkBreaks from "remark-breaks";
import { MarkdownLink, remarkLinkifyPaths } from "./MarkdownLink";
import { markdownUrlTransform } from "./MarkdownLinkCore";

/** MarkdownStream 对外共享的 props；类型导入不会把 Streamdown 拉进入口 chunk。 */
export type MarkdownStreamProps = {
	text: string;
	isStreaming?: boolean;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
	/** 静态场景可追加 remark 插件；GFM 与 codeMeta 由统一管线始终提供。 */
	remarkPlugins?: StreamdownProps["remarkPlugins"];
	/** 草稿本等纯文本预览需要把单换行保留为换行时开启。 */
	breaks?: boolean;
	/** 静态场景可追加 rehype 插件；raw HTML 由统一管线始终提供。 */
	rehypePlugins?: StreamdownProps["rehypePlugins"];
	urlTransform?: (url: string) => string;
	components?: StreamdownProps["components"];
	/** 是否禁用图表/代码高亮等重型渲染（静态小场景如更新日志可关以省内存） */
	light?: boolean;
};

/**
 * 数学公式插件（KaTeX）。@streamdown/math 默认 singleDollarTextMath: false，
 * AI 输出行内公式普遍使用单美元 $...$，因此显式开启单美元解析。
 */
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

/**
 * Streamdown 静态渲染管线。
 *
 * 该模块由 MarkdownStream 的动态 import 加载。这样首屏仍可显示流式纯文本，
 * 但只有消息 settle 或静态预览真正出现时才解析 Streamdown/Shiki/Mermaid。
 */
export const MarkdownStreamRenderer = memo(function MarkdownStreamRenderer(
	props: MarkdownStreamProps,
) {
	const isDark = typeof document !== "undefined" &&
		document.documentElement.dataset.theme === "dark";
	const effectiveLight = Boolean(props.light);
	const resolvedRemarkPlugins = [
		defaultRemarkPlugins.gfm,
		defaultRemarkPlugins.codeMeta,
		...(props.breaks ? [remarkBreaks] : []),
		...(props.remarkPlugins ?? [remarkLinkifyPaths]),
	];
	const resolvedRehypePlugins = [
		defaultRehypePlugins.raw,
		...(props.rehypePlugins ?? []),
	];

	// useMemo 依赖回调 props：回调引用变化时 components 重建，避免链接处理闭包捕获旧值。
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

	return (
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
						}) as StreamdownProps["plugins"]
			}
			mermaid={{
				config: {
					theme: isDark ? "dark" : "default",
					securityLevel: "strict",
				},
			}}
			components={components}
		>
			{props.text}
		</Streamdown>
	);
});
