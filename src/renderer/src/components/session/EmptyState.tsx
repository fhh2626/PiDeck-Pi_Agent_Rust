import type { ReactNode } from "react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

/** 工作台通用空状态，允许调用方注入操作区、上下文和底部信息。 */
export function EmptyState(props: {
	hasProject: boolean;
	onCreate: () => void;
	actions?: ReactNode;
	footer?: ReactNode;
	eyebrow?: ReactNode;
}) {
	const description = props.hasProject
		? t("app.emptyHasProject")
		: t("app.emptyNoProject");

	return (
		<div
			className="empty-state relative h-full min-h-0 overflow-hidden bg-transparent px-6 text-left"
			data-empty-state={props.hasProject ? "project" : "no-project"}
		>
			<div className="mx-auto flex h-full w-full max-w-2xl animate-in flex-col justify-center pt-[10vh] duration-500 fade-in">
				<div className="flex items-center gap-4 text-[13px] text-text-secondary">
					<span className="h-px flex-1 bg-border-subtle" aria-hidden="true"></span>
					{props.eyebrow}
				</div>
				<h2 className="mt-10 animate-in text-[clamp(2.5rem,5vw,3.25rem)] font-semibold leading-[1.1] tracking-[-0.03em] delay-100 duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2 text-foreground">
					{props.hasProject ? (
						<>
							{t("app.emptyProjectTitleLead")}<br />
							<span className="font-brand font-medium italic">{t("app.emptyProjectTitleAccent")}</span>
							<span className="text-foreground">{t("app.emptyProjectTitlePunct")}</span>
						</>
					) : (
						t("app.emptyNoProjectTitle")
					)}
				</h2>
				<p className="mt-6 max-w-md animate-in text-[15px] leading-7 delay-100 duration-500 fade-in fill-mode-backwards text-text-secondary">{description}</p>
				<div className="mt-10 animate-in delay-200 duration-500 fade-in fill-mode-backwards slide-in-from-bottom-2">
					{props.actions ?? (
						props.hasProject ? (
							<Button size="lg" className="h-12 rounded-xl bg-foreground px-7 text-background shadow-sm hover:bg-foreground/85" onClick={props.onCreate}>{t("app.createAgent")}</Button>
						) : (
							<p className="text-sm text-muted-foreground">{t("app.emptyNoProject")}</p>
						)
					)}
				</div>
				{props.footer && (
					<div className="mt-14 animate-in border-t border-border-subtle pt-5 delay-300 duration-500 fade-in fill-mode-backwards">{props.footer}</div>
				)}
			</div>
		</div>
	);
}
