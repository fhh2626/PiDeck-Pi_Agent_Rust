import { useState, type RefObject } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { t } from "../../i18n";
import { loadHtmlToImage } from "../../utils/htmlToImage";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";

/** 将消息节点复制为带背景和留白的 PNG。 */
async function copyElementAsPng(element: HTMLElement) {
	const { toBlob } = await loadHtmlToImage();
	const clone = element.cloneNode(true) as HTMLElement;
	clone.style.padding = "24px";
	clone.style.background =
		getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
	if (element.parentElement) {
		element.parentElement.insertBefore(clone, element.nextSibling);
	}
	let blob: Blob | null = null;
	try {
		blob = await toBlob(clone, {
			cacheBust: true,
			pixelRatio: Math.min(2, window.devicePixelRatio || 1),
			backgroundColor:
				getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
			filter: (node) =>
				!(node instanceof HTMLElement) ||
				(!node.classList.contains("turn-row-actions") &&
					!node.classList.contains("user-turn-actions") &&
					!node.classList.contains("copy-menu-popover")),
		});
	} finally {
		clone.remove();
	}
	if (!blob) return;
	await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

/** 消息复制菜单：纯文本为默认动作，并支持 Markdown 与图片格式。 */
export function CopyMenu(props: {
	text: string;
	markdown: string;
	targetRef: RefObject<HTMLElement | null>;
	className?: string;
}) {
	const [copied, setCopied] = useState<string | null>(null);
	const copy = async (kind: "text" | "markdown" | "image") => {
		try {
			if (kind === "text") await navigator.clipboard.writeText(props.text);
			if (kind === "markdown") await navigator.clipboard.writeText(props.markdown);
			if (kind === "image" && props.targetRef.current) await copyElementAsPng(props.targetRef.current);
			setCopied(kind);
			showNotice(t("copy.success"), 1200);
			window.setTimeout(() => setCopied(null), 1800);
		} catch {
			setCopied(null);
			showNotice(t("copy.failed"), 2000);
		}
	};
	return (
		<div className={`copy-menu ${props.className ?? ""}`}>
			<div className="flex items-center overflow-hidden rounded-sm border border-transparent hover:border-border">
				<Button
					variant="ghost"
					size="icon-sm"
					className="copy-menu-trigger size-7 rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
					type="button"
					onClick={() => void copy("text")}
					title={t("common.copy")}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-6 rounded-none border-l border-border/60 px-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
							type="button"
							aria-label={t("copy.moreOptions")}
							title={t("copy.moreOptions")}
						>
							<ChevronDown size={12} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="copy-menu-popover min-w-[132px]">
						<DropdownMenuItem onSelect={() => void copy("text")}>{t("copy.asText")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copy("markdown")}>{t("copy.asMarkdown")}</DropdownMenuItem>
						<DropdownMenuItem onSelect={() => void copy("image")}>{t("copy.asImage")}</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}
