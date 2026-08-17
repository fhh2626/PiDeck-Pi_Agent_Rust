import { useAtomValue } from "jotai";
import { Activity } from "lucide-react";
import { currentSessionIdAtom } from "../../../atoms";
import { useSessionTrajectorySource } from "../../../hooks/useSessionTrajectorySource";
import { t } from "../../../i18n";
import { SessionTrajectoryView } from "./SessionTrajectoryView";

/**
 * 右侧抽屉「轨迹」面板：跟随当前聚焦会话，不进中栏会话区。
 * 无会话时给空态，避免抽屉 tab 只能在有会话时出现。
 */
export function SessionTrajectoryPanel() {
	const sessionId = useAtomValue(currentSessionIdAtom);
	const source = useSessionTrajectorySource(sessionId);

	if (!sessionId) {
		return (
			<div
				className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 text-center"
				data-session-view="trajectory"
			>
				<Activity size={16} className="text-muted-foreground" aria-hidden="true" />
				<p className="text-caption text-muted-foreground">{t("session.trajectory.noSession")}</p>
			</div>
		);
	}

	return (
		<SessionTrajectoryView
			sessionId={sessionId}
			messages={source.messages}
			processEvents={source.processEvents}
			systemPrompt={source.systemPrompt}
			hasMoreMessages={source.hasMoreMessages}
			isLoadingMoreMessages={source.isLoadingMoreMessages}
			onLoadMore={source.loadMore}
			variant="drawer"
		/>
	);
}
