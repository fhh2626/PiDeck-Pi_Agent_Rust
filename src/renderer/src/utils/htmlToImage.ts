type HtmlToImageModule = typeof import("html-to-image");

let modulePromise: Promise<HtmlToImageModule> | undefined;

/**
 * 截图依赖只在用户实际导出图片时加载，并在多个截图入口之间复用同一个请求。
 * 失败后清空缓存，避免一次瞬时 chunk 错误导致本次应用生命周期内永久不可重试。
 */
export function loadHtmlToImage(): Promise<HtmlToImageModule> {
	if (!modulePromise) {
		modulePromise = import("html-to-image").catch((error: unknown) => {
			modulePromise = undefined;
			throw error;
		});
	}
	return modulePromise;
}
