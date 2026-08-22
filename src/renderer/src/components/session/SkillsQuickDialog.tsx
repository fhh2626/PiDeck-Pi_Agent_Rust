import { useEffect, useState } from "react";
import { Loader2, Sparkles, ToggleLeft, ToggleRight, X } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { Button } from "../ui-shadcn/button";
import type { PiSkillListResult, PiSkillSummary } from "../../../../shared/types";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { desktopApi as api } from "../../desktopApi";

/**
 * Skills 快捷管理小窗口（右侧悬浮工具条入口）：
 * 只承担「查看已加载全局 Skills + 启用/禁用」，复用设置页同一套
 * api.skills.list()/api.skills.toggle()——磁盘上的 SKILL.md 是唯一权威状态，
 * 因此与设置菜单天然同步，无需额外缓存或事件总线。
 *
 * 不含创建/编辑/重命名/删除/打开目录/Skill 商店（那些是 SkillsTab 的职责）。
 * 每次打开都重新 list()；toggle 成功后重新 list() 而非内存反转，
 * 保证「写盘成功」才视为修改成功。
 */
export function SkillsQuickDialog(props: {
	open: boolean;
	/** 全局安全门控（任意 Agent working / 停止中）：为 true 时所有 toggle 立即禁用。 */
	locked: boolean;
	/** 任一次成功的启用/禁用后回调一次（App 据此在关闭时自动停止 Agent）。 */
	onChanged: () => void;
	/** 请求关闭弹窗：关闭动作必须先走 App 的统一处理（判断 changed → stop all）。 */
	onRequestClose: () => void;
}) {
	const [data, setData] = useState<PiSkillListResult>({ locations: [], skills: [] });
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 正在写盘的 skill path；期间禁用全部 toggle 并禁止关闭弹窗。 */
	const [togglingPath, setTogglingPath] = useState<string | null>(null);

	// 每次 open 从 false 变 true 都重新拉取：设置页与快捷窗口之间以磁盘 SKILL.md 为权威，
	// 不做长期缓存，避免打开时看到过期 enabled 状态。
	useEffect(() => {
		if (!props.open) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		api.skills
			.list()
			.then((result) => {
				if (!cancelled) setData(result);
			})
			.catch((e) => {
				if (!cancelled) setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [props.open]);

	const handleToggle = async (skill: PiSkillSummary) => {
		if (props.locked || togglingPath) return;
		setTogglingPath(skill.path);
		setError(null);
		// 与 ConfigModal.handleToggleSkill 同语义：目标态（toggle 后的 enabled）。
		const nextEnabled = !skill.enabled;
		try {
			await api.skills.toggle(skill.path, nextEnabled);
			// 与 ConfigModal.handleToggleSkill 同序：toggle 后重新 list()，
			// 以磁盘状态为准更新视图，而不是仅在 React 内存里反转 enabled。
			const refreshed = await api.skills.list();
			setData(refreshed);
			props.onChanged();
			showNotice(nextEnabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			// toggle 失败不 mark changed：关闭窗口就不会触发 stop all。
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setTogglingPath(null);
		}
	};

	return (
		<Dialog
			open={props.open}
			onOpenChange={(next) => {
				// toggle 写盘进行中禁止关闭：防止 SKILL.md 尚未写完就开始 stop Agent。
				// 不用 DialogClose 自动关窗，关闭动作必须先走 onRequestClose（App 统一判断 changed → stop all）。
				if (!next && !togglingPath) props.onRequestClose();
			}}
		>
			<DialogContent className="max-w-[420px] gap-3 p-5 sm:max-w-[420px]" showCloseButton={false}>
				<DialogHeader>
					<div className="flex items-center justify-between gap-2">
						<DialogTitle className="flex items-center gap-2 text-base">
							<Sparkles size={16} strokeWidth={1.8} className="text-text-tertiary" />
							{t("config.nav.skills")}
						</DialogTitle>
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-7"
							disabled={Boolean(togglingPath)}
							onClick={props.onRequestClose}
							title={t("common.close")}
							aria-label={t("common.close")}
						>
							<X size={16} strokeWidth={1.8} />
						</Button>
					</div>
					<DialogDescription>{t("skills.quickDescription")}</DialogDescription>
				</DialogHeader>
				{/* 列表内部滚动：弹窗整体不超高，Skill 多时在容器内 overflow-y-auto */}
				<div className="max-h-[min(50vh,320px)] min-h-0 overflow-y-auto">
					{loading && data.skills.length === 0 ? (
						<div className="flex items-center justify-center gap-2 py-10 text-control text-muted-foreground">
							<Loader2 size={14} className="animate-spin" />
							<span>{t("common.loading")}</span>
						</div>
					) : error ? (
						<div className="py-6 text-center text-caption text-destructive">{error}</div>
					) : data.skills.length === 0 ? (
						<div className="py-10 text-center text-control text-muted-foreground">
							{t("config.emptySkills")}
						</div>
					) : (
						<ul className="flex flex-col divide-y divide-border/60">
							{data.skills.map((skill) => (
								<li key={skill.id} className="flex items-start justify-between gap-3 py-2.5">
									<div className="flex min-w-0 flex-col gap-0.5">
										<div className="flex min-w-0 items-center gap-2">
											<strong className="truncate text-control font-medium text-foreground">{skill.name}</strong>
											<span className={`skill-state ${skill.enabled ? "enabled" : "disabled"}`}>
												{skill.enabled ? t("common.enabled") : t("common.disabled")}
											</span>
											{!skill.valid && <span className="skill-state invalid">{t("config.needsFix")}</span>}
										</div>
										{skill.description && (
											<span className="line-clamp-2 text-caption leading-relaxed text-muted-foreground" title={skill.description}>
												{skill.description}
											</span>
										)}
										<span className="truncate font-mono text-micro text-muted-foreground">{skill.sourceLabel}</span>
										{skill.warnings.length > 0 && (
											<span className="truncate text-caption text-destructive" title={skill.warnings.join("\n")}>
												{skill.warnings[0]}
											</span>
										)}
									</div>
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7 shrink-0"
										disabled={props.locked || Boolean(togglingPath)}
										onClick={() => void handleToggle(skill)}
										title={skill.enabled ? t("common.disable") : t("common.enabled")}
										style={skill.enabled ? { color: "var(--color-accent)" } : undefined}
									>
										{skill.enabled ? <ToggleRight size={18} strokeWidth={1.8} /> : <ToggleLeft size={18} strokeWidth={1.8} />}
									</Button>
								</li>
							))}
						</ul>
					)}
				</div>
				<p className="text-caption leading-relaxed text-muted-foreground">
					{t("skills.quickApplyHint")}
				</p>
			</DialogContent>
		</Dialog>
	);
}
