import { useCallback, useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/**
 * 内置浏览器 guest 页面请求打开 mailto/tel/sms 等系统协议的确认流。
 *
 * 主进程 guest 导航/弹窗策略拦截到白名单内系统协议后，经
 * appConfirmExternalProtocol 推送到主窗口；本 hook 持有该确认请求状态，
 * 用户同意后经 browser.openExternal 回流同一网关。
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

	// TOCTOU 门禁：确认框已打开时锁定第一条请求，后续推送丢弃不覆盖——
	// 否则远程脚本可在用户点击前的最后一刻把 A 换成 B（用户看到的与
	// 实际交给系统处理器的必须一致）。functional updater 是纯函数
	// （只做 ?? 选择），与「副作用不得进 updater」的约定不冲突。
	const acceptRequest = useCallback((next: string) => {
		setUrl((current) => current ?? next);
	}, []);

	useEffect(() => {
		const off = desktopApi.app.onConfirmExternalProtocol?.(acceptRequest);
		return () => off?.();
	}, [acceptRequest]);

	const requestConfirm = acceptRequest;
	const confirm = useCallback(() => {
		if (url) void desktopApi.browser.openExternal(url);
		setUrl(null);
	}, [url]);
	const dismiss = useCallback(() => setUrl(null), []);

	return { url, requestConfirm, confirm, dismiss };
}
