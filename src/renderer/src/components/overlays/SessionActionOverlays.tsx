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
	// mailto:user@example.com 等 WHATWG 解析不出 host 的 URL 直接展示原串，
	// http(s) 展示 host 避免超长 query 干扰阅读。
	let display = request.url;
	try {
		const parsed = new URL(request.url);
		if (parsed.host) display = parsed.host;
	} catch {
		// 保持原串
	}
	return (
		<ConfirmDialog
			title={t("browser.externalProtocolTitle")}
			message={t("browser.externalProtocolMessage", { url: display })}
			onConfirm={request.onConfirm}
			onCancel={request.onCancel}
		/>
	);
}
