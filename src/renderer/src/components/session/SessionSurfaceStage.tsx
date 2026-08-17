import { ChevronDown } from "lucide-react";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { SessionMessageTimelineProps } from "./SessionMessageTimeline";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { t } from "../../i18n";

/**
 * 中栏表面：只承载对话时间线。轨迹复盘已迁到右侧抽屉独立 tab。
 */
export function SessionSurfaceStage(props: {
	sessionId: string;
	sessionTimeline: SessionTimelineController;
	timelineProps: Omit<SessionMessageTimelineProps, "sessionId" | "controller">;
	isRestarting: boolean;
}) {
	const { sessionId, sessionTimeline, timelineProps, isRestarting } = props;
	return (
		<div className="relative h-full min-h-0">
			<SessionMessageTimeline
				sessionId={sessionId}
				controller={sessionTimeline}
				{...timelineProps}
			/>

			{sessionTimeline.showScrollToBottom && (
				<button
					className="scroll-to-bottom-btn"
					onClick={sessionTimeline.scrollToBottom}
					title={t("app.scrollToBottom")}
					aria-label={t("app.scrollToBottom")}
				>
					<ChevronDown size={18} />
				</button>
			)}
			{/* 重启动画：opacity 过渡 + loader 旋转均为合成器驱动（transform/opacity），
			    不占用渲染主线程，不会导致窗口卡顿；始终挂载以支持重启结束时的平滑淡出。 */}
			<div
				className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-bg-panel/70 transition-opacity duration-200 ${isRestarting ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
				role={isRestarting ? "status" : undefined}
				aria-hidden={!isRestarting}
			>
				<div className="loader" />
				<span className="text-body text-text-secondary">{t("app.restarting")}</span>
			</div>
		</div>
	);
}
