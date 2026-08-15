/**
 * 生成进行中切换模型的「待生效」展示推导。
 *
 * pi 不支持运行中 set_model：本轮仍用旧模型，选择只写入会话记录。
 * 本轮结束后再套到 Agent。新加、不在启动快照里的模型不走这条路径（走重启确认）。
 */

export type ModelPendingRef = {
	provider: string;
	modelId: string;
	modelName?: string;
};

export type ModelPending = {
	from: ModelPendingRef;
	to: ModelPendingRef;
};

export function formatModelRef(ref: Pick<ModelPendingRef, "provider" | "modelId" | "modelName">): string {
	const name = ref.modelName || ref.modelId || "-";
	return ref.provider ? `${ref.provider}/${name}` : name;
}

export type ModelDisplayResult = {
	from?: ModelPendingRef;
	to?: ModelPendingRef;
	pending: boolean;
};

export function computeModelDisplay(
	current: ModelPendingRef | undefined,
	pending: ModelPending | undefined,
): ModelDisplayResult {
	if (pending) {
		return { from: pending.from, to: pending.to, pending: true };
	}
	return { from: current, pending: false };
}
