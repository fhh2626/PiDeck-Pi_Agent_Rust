import { lazy, Suspense, type ComponentProps } from "react";
const SettingsModal = lazy(() => import("../app/SettingsModal").then((module) => ({ default: module.SettingsModal })));
import { ConfirmDialog } from "./OverlayParts";
import { TrustConfirmModal } from "../app/TrustConfirmModal";
import { t } from "../../i18n";
export type TrustOverlayProps = {
	open: boolean;
	requestId: string;
	cwd: string;
	projectName: string;
	onChoose: (choice: "trust-remember" | "trust-session" | "deny") => void | Promise<void>;
};

export type SessionActionOverlaysProps = {
	settings?: { open: boolean; props: ComponentProps<typeof SettingsModal> };
	confirm?: { open: boolean; props: ComponentProps<typeof ConfirmDialog> };
	trust?: TrustOverlayProps;
	externalProtocol?: {
		open: boolean;
		url: string;
		onConfirm: () => void;
		onCancel: () => void;
	};
};

export function SessionActionOverlays({ settings, confirm, trust, externalProtocol }: SessionActionOverlaysProps) {
	return <>
		{settings?.open && <Suspense fallback={null}><SettingsModal {...settings.props} /></Suspense>}
		{confirm?.open && <ConfirmDialog {...confirm.props} />}
		{trust?.open && <TrustConfirmModal cwd={trust.cwd} projectName={trust.projectName} onChoose={trust.onChoose} />}
		<ExternalProtocolConfirmOverlay request={externalProtocol} />
	</>;
}

/** guest 页面请求 mailto/tel/sms 的确认框：主进程推送 → 用户同意才经网关启动系统处理器。 */
function ExternalProtocolConfirmOverlay({ request }: { request?: NonNullable<SessionActionOverlaysProps["externalProtocol"]> }) {
	if (!request?.open) return null;
	// 必须展示完整 URI（含 query）：用户看到的内容必须与之后交给系统处理器的
	// 一致——sms:/mailto: 的 query 可携带正文/subject，只显示 host 会掩盖真实目标。
	// 超长 URI 截断尾部并以 … 提示（信息不完整时用户应拒绝），换行由 CSS 处理。
	const MAX_URL_DISPLAY = 160;
	const display =
		request.url.length > MAX_URL_DISPLAY
			? `${request.url.slice(0, MAX_URL_DISPLAY)}…`
			: request.url;
	return (
		<ConfirmDialog
			title={t("browser.externalProtocolTitle")}
			message={t("browser.externalProtocolMessage", { url: display })}
			messageClassName="break-all"
			onConfirm={request.onConfirm}
			onCancel={request.onCancel}
		/>
	);
}
