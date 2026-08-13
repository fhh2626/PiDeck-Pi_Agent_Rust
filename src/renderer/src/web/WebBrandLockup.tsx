/**
 * WebBrandLockup — Web 端品牌区（与桌面 AppParts.BrandLockup 同视觉）。
 *
 * 不直接复用 AppParts.BrandLockup 是为了避免把桌面端整棵渲染组件树
 * （SurfaceComponents / atoms / desktopApi 等）拖进 Web 包；这里只复用
 * 自包含的 PiLogoCanvas（仅依赖 React hooks + CSS 变量，无变量时回退）。
 */
import { PiLogoCanvas } from "../components/app/PiLogoCanvas";

export function WebBrandLockup() {
	return (
		<div className="brand-lockup flex h-9 min-w-0 items-center gap-2.5" aria-label="PiDeck-Q">
			<PiLogoCanvas size={28} autoPlay playOnClick />
			<span
				className="brand-wordmark translate-x-0.5 truncate text-[18px] font-[PiDeckDepartureMono] font-normal uppercase leading-none text-zinc-950 dark:text-white"
				aria-hidden="true"
			>
				PiDeck-Q
			</span>
		</div>
	);
}
