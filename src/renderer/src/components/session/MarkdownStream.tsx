import { Fragment, lazy, memo, Suspense } from "react";
import { FormulaCopyLayer } from "./FormulaCopyLayer";
import { useSmoothStream } from "../../utils/useSmoothStream";
import type { MarkdownStreamProps } from "./MarkdownStreamRenderer";

export type { MarkdownStreamProps } from "./MarkdownStreamRenderer";

/**
 * 流式超长兜底阈值（字符数，UTF-16 code unit）。
 *
 * 流式主路径只渲染纯文本；该阈值防止异常超长输出把渲染进程拖入高频
 * Markdown 解析。消息结束后才切换到完整 Streamdown 管线。
 */
export const STREAM_LIGHT_MAX_CHARS = 8_000;

/** 静态消息的重型 Markdown 管线只在首次需要时加载。 */
const MarkdownStreamRenderer = lazy(() =>
	import("./MarkdownStreamRenderer").then(({ MarkdownStreamRenderer: renderer }) => ({
		default: renderer,
	})),
);

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
 * 流式消息的轻量显示层。
 *
 * 这里不能依赖 Streamdown：Agent 首字节到达时不应为了 Markdown、Shiki
 * 或 Mermaid 下载/解析整套静态渲染器。消息 settle 后由外层切换到动态组件。
 */
const MarkdownStreamLive = memo(function MarkdownStreamLive(props: MarkdownStreamProps) {
	const { displayedContent } = useSmoothStream({
		content: props.text,
		isStreaming: true,
	});
	const displayText = displayedContent;
	const streamPlain = displayText.length > STREAM_LIGHT_MAX_CHARS;
	const liveText = streamPlain ? displayText : streamingDisplayText(displayText);

	return <div className="whitespace-pre-wrap break-words">{liveText}</div>;
});

/**
 * Markdown 统一入口。
 *
 * 选中会话或空工作台时只加载这个轻量 wrapper；Streamdown、@streamdown/code
 * 和 @streamdown/mermaid 留在动态 chunk，避免入口 HTML 预加载 Mermaid 全家桶。
 */
export const MarkdownStream = memo(function MarkdownStream(props: MarkdownStreamProps) {
	const streamLive = Boolean(props.isStreaming);
	const fallback = (
		<div className="whitespace-pre-wrap break-words">{props.text}</div>
	);

	return (
		<Fragment>
			{streamLive ? (
				<MarkdownStreamLive {...props} />
			) : (
				<Suspense fallback={fallback}>
					<MarkdownStreamRenderer {...props} />
				</Suspense>
			)}
			<FormulaCopyLayer />
		</Fragment>
	);
});
