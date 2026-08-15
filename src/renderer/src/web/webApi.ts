/**
 * webApi — Web 端与主进程 WebServiceManager 的 HTTP 数据访问层。
 *
 * 覆盖范围（与桌面端对齐但收窄）：
 * - /api/state：项目/会话/运行态轮询
 * - /api/sessions（POST）：按项目新建会话
 * - /api/sessions/:id/messages/page：历史消息分页
 * - 发送消息走 useChat（/api/chat 流式），不在此处重复实现
 */
import type { UIMessage } from "ai";
import type {
	AvailableModel,
	ChatMessage,
	SessionCommandResult,
	SessionLaunchPreferences,
	SessionMessagePage,
	SessionRuntimeTarget,
	SessionTargetedValue,
	UpdateSessionRecordInput,
} from "../../../shared/types";
import type { WebState } from "./webTypes";

/** 轮询 /api/state 拿项目/会话/运行态（低频兜底，主数据流走 useChat）。 */
export async function fetchState(): Promise<WebState> {
	const res = await fetch("/api/state");
	if (!res.ok) throw new Error(`state ${res.status}`);
	return res.json();
}

/** 从 Web 端注册一个本地项目路径，返回项目记录。 */
export async function createProject(path: string): Promise<WebState["projects"][number]> {
	const res = await fetch("/api/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	if (!res.ok) throw new Error(`create project ${res.status}`);
	const result = (await res.json()) as { project?: WebState["projects"][number] };
	if (!result.project) throw new Error("create project: missing project");
	return result.project;
}

/** 删除项目登记记录；不会删除项目目录或工作区文件。 */
export async function deleteProject(projectId: string): Promise<void> {
	const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/delete`, { method: "POST" });
	if (!res.ok) throw new Error(`delete project ${res.status}`);
}

/** 读取 pi 当前可用模型，草稿会话也可以先选模型再发送第一条消息。 */
export async function fetchModels(): Promise<AvailableModel[]> {
	const res = await fetch("/api/models");
	if (!res.ok) throw new Error(`models ${res.status}`);
	const result = (await res.json()) as { models?: AvailableModel[] };
	return result.models ?? [];
}

/** 按项目新建会话（对应桌面端「新建 Agent」入口）。返回新会话 id。 */
/**
 * 新建会话草稿；preferences 携带启动前选择的模型/思考级别（首页直发场景），
 * 无偏好时保持后端默认（pi 配置默认值）。
 */
export async function createSession(
	projectId: string,
	preferences?: SessionLaunchPreferences,
): Promise<string> {
	const res = await fetch("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ projectId, ...preferences }),
	});
	if (!res.ok) throw new Error(`create session ${res.status}`);
	const result = (await res.json()) as { session?: { id?: string } };
	const id = result.session?.id;
	if (!id) throw new Error("create session: missing session id");
	return id;
}

/** 拉历史消息页（分页），供注入 useChat / 展示。 */
/** 更新尚未启动 runtime 的会话偏好；运行中的会话由 runtime 命令即时应用。 */
export async function updateSessionRecord(
	sessionId: string,
	patch: UpdateSessionRecordInput,
): Promise<void> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/update`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update session ${res.status}`);
}

async function callRuntimeCommand<T>(
	sessionId: string,
	target: SessionRuntimeTarget,
	action: string,
	body: Record<string, unknown> = {},
): Promise<T> {
	const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/runtime/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ target, ...body }),
	});
	if (!res.ok) throw new Error(`runtime ${action} ${res.status}`);
	const payload = (await res.json()) as { result?: SessionCommandResult<SessionTargetedValue<T>> };
	const result = payload.result;
	if (!result || !result.ok) {
		throw new Error(result?.error.code ?? `runtime ${action} failed`);
	}
	return result.value.value;
}

/** 运行中的模型切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeModel(
	target: SessionRuntimeTarget,
	provider: string,
	modelId: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "model", { provider, modelId });
}

/** 运行中的思考级别切换会立即发送给 pi，并由主进程同步会话记录。 */
export function setRuntimeThinking(
	target: SessionRuntimeTarget,
	level: string,
): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "thinking", { level });
}

/** 中止当前 Session 的运行时，而不是只关掉 Web 前端的 SSE。 */
export function abortRuntime(target: SessionRuntimeTarget): Promise<unknown> {
	return callRuntimeCommand(target.sessionId, target, "abort");
}

export async function fetchMessagePage(
	sessionId: string,
	before?: number,
	pageSize?: number,
): Promise<SessionMessagePage> {
	const params = new URLSearchParams();
	if (before != null) params.set("before", String(before));
	if (pageSize != null) params.set("pageSize", String(pageSize));
	const qs = params.toString();
	const res = await fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/messages/page${qs ? `?${qs}` : ""}`,
	);
	if (!res.ok) throw new Error(`messages ${res.status}`);
	return (await res.json()) as SessionMessagePage;
}

/**
 * 历史 ChatMessage 列表 → useChat 的 UIMessage[]（text-only parts）。
 * 历史消息仅注入正文；流式思考/工具由 useChat 从 SSE 实时构建，避免与
 * 静态历史重复。ChatMessage.thinking 存在时一并注入 reasoning part，
 * 让历史会话也能折叠查看思考过程。
 */
export function chatMessagesToUiMessages(messages: ChatMessage[]): UIMessage[] {
	return messages.map((message) => {
		const role =
			message.role === "user"
				? "user"
				: message.role === "assistant"
					? "assistant"
					: "assistant";
		const parts: UIMessage["parts"] = [];
		if (message.thinking) {
			parts.push({ type: "reasoning", text: message.thinking });
		}
		if (message.text) {
			parts.push({ type: "text", text: message.text });
		}
		return {
			id: message.id ?? `hist-${message.timestamp ?? Math.random()}`,
			role,
			parts,
		};
	});
}

function uiMessageText(message: UIMessage): string {
	return message.parts
		.map((part) => {
			if (part.type === "text" || part.type === "reasoning") return part.text;
			return "";
		})
		.join("");
}

function sameUiMessage(left: UIMessage, right: UIMessage): boolean {
	return left.id === right.id
		&& left.role === right.role
		&& JSON.stringify(left.parts) === JSON.stringify(right.parts);
}

/**
 * 用主进程运行时快照补偿 Web 本地 useChat 缓存。
 *
 * Web 自己生成的 user/assistant id 与 pi 落盘 id 不同，因此先按稳定 id 匹配，
 * 再按角色与文本（含“局部文本 → 完整文本”）匹配，避免 PC 端消息轮询到 Web 后
 * 变成重复气泡。快照只覆盖运行期尾部，未包含的旧消息保留给历史分页缓存。
 */
export function mergeAuthoritativeUiMessages(
	current: UIMessage[],
	authoritative: UIMessage[],
): UIMessage[] {
	if (authoritative.length === 0) return current;
	const merged = [...current];
	const matchedCurrent = new Set<number>();
	let changed = false;

	for (const incoming of authoritative) {
		let matchIndex = -1;
		for (let index = 0; index < merged.length; index += 1) {
			if (!matchedCurrent.has(index) && merged[index].id === incoming.id) {
				matchIndex = index;
				break;
			}
		}

		const incomingText = uiMessageText(incoming);
		if (matchIndex < 0) {
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				const candidate = merged[index];
				if (
					matchedCurrent.has(index)
					|| candidate.role !== incoming.role
					|| uiMessageText(candidate) !== incomingText
				) continue;
				matchIndex = index;
				break;
			}
		}

		// 流式缓存可能只保留了前缀，而轮询快照已经拿到完整正文。
		if (matchIndex < 0 && incomingText) {
			for (let index = merged.length - 1; index >= 0; index -= 1) {
				const candidateText = uiMessageText(merged[index]);
				if (
					matchedCurrent.has(index)
					|| merged[index].role !== incoming.role
					|| !candidateText
					|| !(incomingText.startsWith(candidateText) || candidateText.startsWith(incomingText))
				) continue;
				matchIndex = index;
				break;
			}
		}

		if (matchIndex >= 0) {
			matchedCurrent.add(matchIndex);
			if (!sameUiMessage(merged[matchIndex], incoming)) {
				merged[matchIndex] = incoming;
				changed = true;
			}
			continue;
		}

		merged.push(incoming);
		matchedCurrent.add(merged.length - 1);
		changed = true;
	}

	return changed ? merged : current;
}
