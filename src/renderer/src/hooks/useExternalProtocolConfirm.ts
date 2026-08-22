import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/**
 * 内置浏览器 guest 页面请求打开 mailto/tel/sms 等系统协议的确认流。
 *
 * 主进程 guest 导航/弹窗策略拦截到白名单内系统协议后，经
 * appConfirmExternalProtocol 推送到主窗口；本 hook 持有该确认请求状态，
 * 用户同意后经 browser.openExternal(forceSystem=true) 回流同一网关。
 *
 * 独立于 useOverlayActions：后者是既有 confirm/trust 域（有范围收敛门禁），
 * 浏览器外部协议确认属于 browser feature 域，不并入通用 overlay 状态。
 */
export function useExternalProtocolConfirm(): {
	url: string | null;
	requestConfirm: (url: string) => void;
	confirm: () => void;
	dismiss: () => void;
} {
	const [url, setUrl] = useState<string | null>(null);

	useEffect(() => {
		const off = desktopApi.app.onConfirmExternalProtocol?.((next) => setUrl(next));
		return () => off?.();
	}, []);

	const requestConfirm = useCallback((next: string) => setUrl(next), []);
	const confirm = useCallback(() => {
		// 副作用不放进 setState updater：StrictMode 开发模式下 updater 会被刻意
		// 双调用（暴露非纯函数），会把系统处理器拉起两次。闭包捕获当前 url，
		// 对话框仅在 url != null 时渲染。
		if (url) void desktopApi.browser.openExternal(url, true);
		setUrl(null);
	}, [url]);
	const dismiss = useCallback(() => setUrl(null), []);

	return { url, requestConfirm, confirm, dismiss };
}
