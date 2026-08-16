/**
 * WebChatApp — PiDeck Web 服务 React 前端（A2）重构后的组合根。
 *
 * 数据层保持原有架构：
 * - useChat + DefaultChatTransport 消费 /api/chat 流式（AI SDK v7 UIMessageStream）
 * - /api/state 低频轮询兜底项目/会话/运行态
 * - 历史消息按会话注入 useChat；useChat 切换 id 会重建 Chat 实例（不保留
 *   上一会话消息），因此本组件持有自己的 per-session 消息缓存，
 *   切回会话时直接从缓存恢复，避免重复拉取与闪空。
 *
 * UI 层与桌面端对齐：WebSidebar / WebHeader / WebTimeline / WebComposer，
 * 复用桌面设计 token、shadcn 组件、lucide 图标与 timeline/surfaces 样式类。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import type { AvailableModel } from "../../../shared/types";
import { t } from "@/i18n";
import { WebSidebar } from "./WebSidebar";
import { WebHeader, type WebHeaderStatus } from "./WebHeader";
import { WebTimeline } from "./WebTimeline";
import { WebComposer } from "./WebComposer";
import {
	chatMessagesToUiMessages,
	createProject,
	createSession,
	deleteProject,
	fetchMessagePage,
	fetchModels,
	fetchState,
	mergeAuthoritativeUiMessages,
	abortRuntime,
	setRuntimeModel,
	setRuntimeThinking,
	updateSessionRecord,
} from "./webApi";
import type { WebProject, WebState } from "./webTypes";

/** 分页元数据：已加载消息总数 + 更早一页的游标。 */
type HistoryMeta = {
	total: number;
	nextBefore: number | null;
};

export function WebChatApp() {
	const [state, setState] = useState<WebState>({
		projects: [],
		sessions: [],
		runtimes: [],
		messagesBySession: {},
	});
	const [activeSessionId, setActiveSessionId] = useState<string>("");
	const [creatingProjectId, setCreatingProjectId] = useState<string>("");
	const [connected, setConnected] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [commandError, setCommandError] = useState<string | null>(null);
	// 首页（无会话）时选择的模型/思考级别：暂存为待用偏好，随下一次新建会话生效
	const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
	const [pendingThinkingLevel, setPendingThinkingLevel] = useState<string | null>(null);
	// 手机端默认把聊天作为主画面，项目树通过抽屉按需打开，避免列表占满首屏。
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

	// Mobile Safari/Chrome keep 100vh on the layout viewport. The address bar and
	// keyboard change visualViewport metrics; syncing the whole rectangle keeps
	// the shell and its drawer aligned with what the user can actually see.
	useEffect(() => {
		const updateViewportMetrics = () => {
			const viewport = window.visualViewport;
			const height = viewport?.height ?? window.innerHeight;
			const width = viewport?.width ?? window.innerWidth;
			const offsetTop = Math.max(0, viewport?.offsetTop ?? 0);
			const offsetLeft = Math.max(0, viewport?.offsetLeft ?? 0);
			document.documentElement.style.setProperty("--web-viewport-height", `${height}px`);
			document.documentElement.style.setProperty("--web-viewport-width", `${width}px`);
			document.documentElement.style.setProperty("--web-viewport-offset-left", `${offsetLeft}px`);
			document.documentElement.style.setProperty("--web-viewport-offset-top", `${offsetTop}px`);
		};
		const viewport = window.visualViewport;
		updateViewportMetrics();
		viewport?.addEventListener("resize", updateViewportMetrics);
		viewport?.addEventListener("scroll", updateViewportMetrics);
		window.addEventListener("resize", updateViewportMetrics);
		return () => {
			viewport?.removeEventListener("resize", updateViewportMetrics);
			viewport?.removeEventListener("scroll", updateViewportMetrics);
			window.removeEventListener("resize", updateViewportMetrics);
			document.documentElement.style.removeProperty("--web-viewport-height");
			document.documentElement.style.removeProperty("--web-viewport-width");
			document.documentElement.style.removeProperty("--web-viewport-offset-left");
			document.documentElement.style.removeProperty("--web-viewport-offset-top");
		};
	}, []);

	// ── 本组件自持的 per-session 消息缓存（useChat 切换 id 会重建 Chat 实例） ──
	const messagesBySessionRef = useRef<Record<string, UIMessage[]>>({});
	const loadedSessionsRef = useRef<Set<string>>(new Set());
	const historyMetaRef = useRef<Record<string, HistoryMeta>>({});
	const activeSessionIdRef = useRef<string>("");
	const streamingRef = useRef(false);
	// 首页直发暂存：新建会话后等 useChat 实例切换完成，再投递首条消息
	const pendingSendRef = useRef<{ sessionId: string; text: string } | null>(null);

	// useChat：sessionId 作为 chat id；切会话时 id 变化重建 Chat 实例
	const { messages, sendMessage, status, stop, setMessages, error } = useChat({
		id: activeSessionId,
		transport: new DefaultChatTransport({ api: "/api/chat" }),
	});

	const streaming = status === "submitted" || status === "streaming";

	activeSessionIdRef.current = activeSessionId;
	streamingRef.current = streaming;

	/** 将主进程运行时尾部快照合并回 Web 缓存，避免轮询覆盖正在显示的流。 */
	const syncRuntimeMessages = useCallback((nextState: WebState, sessionId: string) => {
		if (!sessionId) return;
		const snapshot = nextState.messagesBySession[sessionId];
		if (!snapshot) return;
		const authoritative = chatMessagesToUiMessages(snapshot);
		const current = messagesBySessionRef.current[sessionId] ?? [];
		const merged = mergeAuthoritativeUiMessages(current, authoritative);
		messagesBySessionRef.current[sessionId] = merged;
		// 流式期间由 SSE/useChat 保持逐 token 画面；状态快照只更新缓存，
		// 等状态变为空闲后再替换为主进程的最终消息。
		// 主进程运行时快照只含尾部窗口。空闲后如果直接整表替换，
		// 刚结束的 SSE 回复可能被更早的投影片段覆盖，表现为“这条没回、下一条回了两次”。
		if (!streamingRef.current && activeSessionIdRef.current === sessionId && merged !== current) {
			setMessages((visible) => mergeAuthoritativeUiMessages(visible, merged));
		}
	}, [setMessages]);

	const runtimeFor = (sessionId: string) =>
		state.runtimes.find((runtime) => runtime.sessionId === sessionId);
	const activeSession = state.sessions.find((session) => session.id === activeSessionId);
	const activeRuntime = activeSessionId ? runtimeFor(activeSessionId) : undefined;

	// 切换会话：优先从缓存恢复；未加载过则拉取历史页注入
	useEffect(() => {
		if (!activeSessionId) return;
		if (loadedSessionsRef.current.has(activeSessionId)) {
			setMessages(messagesBySessionRef.current[activeSessionId] ?? []);
			return;
		}
		void fetchMessagePage(activeSessionId)
			.then((page) => {
				const history = chatMessagesToUiMessages(page.messages);
				const cached = messagesBySessionRef.current[activeSessionId] ?? [];
				const merged = mergeAuthoritativeUiMessages(history, cached);
				messagesBySessionRef.current[activeSessionId] = merged;
				historyMetaRef.current[activeSessionId] = {
					total: page.total,
					nextBefore: page.nextBefore,
				};
				loadedSessionsRef.current.add(activeSessionId);
				// 仅当仍停留在该会话时才注入（避免切走后 setMessages 串台）
				if (activeSessionIdRef.current === activeSessionId) {
					setMessages(merged);
				}
			})
			.catch(() => {
				// 历史加载失败：保留空时间线，不阻塞流式
			});
	}, [activeSessionId, setMessages]);

	// 轮询拿到的运行时快照也要在切换会话/流结束后立即回放，
	// 否则 Web 只显示自己发出的 SSE，PC 端新增的消息永远要等重新打开页面才出现。
	useEffect(() => {
		if (!activeSessionId || streaming) return;
		syncRuntimeMessages(state, activeSessionId);
	}, [activeSessionId, state, streaming, syncRuntimeMessages]);

	// 流式期间同步缓存：仅 streaming 时回写（空闲时 setMessages 来自历史恢复/分页，
	// 对应逻辑已各自写缓存；这里若无条件覆盖会把刚恢复的历史再次清空）
	useEffect(() => {
		if (!activeSessionId || !streaming) return;
		messagesBySessionRef.current[activeSessionId] = messages;
		loadedSessionsRef.current.add(activeSessionId);
	}, [messages, activeSessionId, streaming]);

	// 首页直发：useChat 随 activeSessionId 切换在渲染期重建实例（@ai-sdk/react 在 render 中
	// 直接替换 chatRef.current），因此本 effect 里拿到的 sendMessage 已属于新会话；
	// 用 sessionId 校验防止用户在创建期间切到其他会话后串台。
	useEffect(() => {
		const pending = pendingSendRef.current;
		if (!pending || pending.sessionId !== activeSessionId) return;
		if (streaming) return; // 新实例就绪（空闲）后才投递
		pendingSendRef.current = null;
		void sendMessage({ text: pending.text });
	}, [activeSessionId, streaming, sendMessage]);

	// 模型列表是全局 pi 配置，草稿会话也需要先选模型再发送第一条消息。
	useEffect(() => {
		void fetchModels().then(setModels).catch(() => setModels([]));
	}, []);

	// 低频轮询项目/会话/运行态（3s；useChat 负责消息流，不参与轮询）
	useEffect(() => {
		let disposed = false;
		const refresh = async () => {
			try {
				const next = await fetchState();
				if (disposed) return;
				setState(next);
				syncRuntimeMessages(next, activeSessionIdRef.current);
				setConnected(true);
				// 清理已被外部删除的会话缓存
				const validSessionIds = new Set(next.sessions.map((s) => s.id));
				for (const id of Object.keys(messagesBySessionRef.current)) {
					if (!validSessionIds.has(id)) {
						delete messagesBySessionRef.current[id];
						delete historyMetaRef.current[id];
						loadedSessionsRef.current.delete(id);
					}
				}
				// 初始页面保持空会话，让用户明确选择项目/会话；外部删除当前会话时也回到空状态。
				if (activeSessionIdRef.current && !next.sessions.some((session) => session.id === activeSessionIdRef.current)) {
					setActiveSessionId("");
				}
			} catch {
				if (!disposed) setConnected(false);
			}
		};
		void refresh();
		const timer = setInterval(refresh, 3000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
		// activeSessionId 变化后下一轮轮询会补齐最新状态，不必重启轮询
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [syncRuntimeMessages]);

	const handleSend = (text: string) => {
		if (!text.trim()) return;
		if (!activeSessionId) {
			// 首页直发：无会话时自动新建会话（携带已选模型/思考级别）再投递首条消息
			void sendFromHome(text);
			return;
		}
		void sendMessage({ text });
	};

	const handleStop = () => {
		stop();
		if (!activeRuntime) return;
		void abortRuntime({
			sessionId: activeRuntime.sessionId,
			agentId: activeRuntime.agentId,
			runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
		}).catch((error) => {
			setCommandError(error instanceof Error ? error.message : String(error));
		});
	};

	// 首页直发流程：优先内置 chat 项目（未配置项目时的兜底），否则取第一个项目；
	// 创建期间复用 creatingProjectId 短暂禁用输入，防止重复提交。
	const sendFromHome = async (text: string) => {
		const project = state.projects.find((candidate) => candidate.kind === "chat") ?? state.projects[0];
		if (!project) {
			setCommandError(t("web.sendNoProject"));
			return;
		}
		setCreatingProjectId(project.id);
		setCommandError(null);
		try {
			const id = await createSession(project.id, {
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			// 会话 id 变化后 useChat 重建实例；等新实例就绪再投递（见上方 effect）
			pendingSendRef.current = { sessionId: id, text };
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
			setConnected(false);
		} finally {
			setCreatingProjectId("");
		}
	};

	// 新会话无历史：预标记为已加载（空缓存），避免切过去时多余拉取
	const markSessionLoaded = (id: string) => {
		loadedSessionsRef.current.add(id);
		messagesBySessionRef.current[id] = [];
		historyMetaRef.current[id] = { total: 0, nextBefore: null };
	};

	const handleCreateSession = async (projectId: string) => {
		setCreatingProjectId(projectId);
		setCommandError(null);
		try {
			const id = await createSession(projectId, {
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
			setConnected(false);
		} finally {
			setCreatingProjectId("");
		}
	};

	const handleCreateProject = async (path: string): Promise<WebProject> => {
		setCommandError(null);
		try {
			const project = await createProject(path);
			await refreshNow();
			return project;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setCommandError(message);
			throw error;
		}
	};

	const handleDeleteProject = async (projectId: string) => {
		setCommandError(null);
		try {
			const deletedSessions = state.sessions.filter((session) => session.projectId === projectId);
			await deleteProject(projectId);
			for (const session of deletedSessions) {
				delete messagesBySessionRef.current[session.id];
				delete historyMetaRef.current[session.id];
				loadedSessionsRef.current.delete(session.id);
			}
			setState((current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
				sessions: current.sessions.filter((session) => session.projectId !== projectId),
				runtimes: current.runtimes.filter((runtime) => !deletedSessions.some((session) => session.id === runtime.sessionId)),
			}));
			if (deletedSessions.some((session) => session.id === activeSessionId)) {
				setActiveSessionId("");
			}
			setMobileSidebarOpen(false);
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const updateActiveSessionState = (patch: { model?: { provider: string; modelId: string }; thinkingLevel?: string }) => {
		setState((current) => ({
			...current,
			sessions: current.sessions.map((session) =>
				session.id === activeSessionId ? { ...session, ...patch } : session,
			),
		}));
	};

	const handleModelChange = async (model: AvailableModel) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingModel({ provider: model.provider, modelId: model.id });
			return;
		}
		setCommandError(null);
		try {
			if (activeRuntime) {
				await setRuntimeModel(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					model.provider,
					model.id,
				);
			} else {
				await updateSessionRecord(activeSessionId, {
					model: { provider: model.provider, modelId: model.id },
				});
			}
			updateActiveSessionState({ model: { provider: model.provider, modelId: model.id } });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleThinkingChange = async (level: string) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingThinkingLevel(level);
			return;
		}
		setCommandError(null);
		try {
			if (activeRuntime) {
				await setRuntimeThinking(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					level,
				);
			} else {
				await updateSessionRecord(activeSessionId, { thinkingLevel: level });
			}
			updateActiveSessionState({ thinkingLevel: level });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const refreshNow = async () => {
		try {
			const next = await fetchState();
			setState(next);
			syncRuntimeMessages(next, activeSessionIdRef.current);
			setConnected(true);
		} catch {
			setConnected(false);
		}
	};

	const handleLoadMore = async () => {
		if (!activeSessionId || streaming || loadingMore) return;
		const meta = historyMetaRef.current[activeSessionId];
		if (!meta || meta.nextBefore == null) return;
		setLoadingMore(true);
		try {
			const page = await fetchMessagePage(activeSessionId, meta.nextBefore);
			// 前插更早的消息：更新缓存与游标后，把「旧页 + 当前全部消息」重新注入
			historyMetaRef.current[activeSessionId] = {
				total: page.total,
				nextBefore: page.nextBefore,
			};
			const older = chatMessagesToUiMessages(page.messages);
			const merged = [...older, ...messagesBySessionRef.current[activeSessionId]];
			messagesBySessionRef.current[activeSessionId] = merged;
			setMessages(merged);
		} catch {
			// 分页失败保持现状
		} finally {
			setLoadingMore(false);
		}
	};

	// 头部运行态：流式优先；否则用轮询到的 runtime 状态兜底
	const headerStatus: WebHeaderStatus = (() => {
		if (streaming) return "running";
		const runtimeStatus = activeRuntime?.status;
		if (runtimeStatus === "starting") return "starting";
		if (runtimeStatus === "running") return "running";
		if (runtimeStatus === "error") return "error";
		return "idle";
	})();

	const activeMeta = activeSessionId ? historyMetaRef.current[activeSessionId] : undefined;
	const hasMoreHistory = Boolean(activeMeta && activeMeta.nextBefore != null && !streaming);
	const moreCount = activeMeta
		? Math.max(0, activeMeta.total - messagesBySessionRef.current[activeSessionId]?.length)
		: 0;

	return (
		<div className="app wechat-shell flex h-full w-full min-w-0 overflow-hidden bg-background text-foreground">
			<WebSidebar
				state={state}
				activeSessionId={activeSessionId}
				creatingProjectId={creatingProjectId}
				connected={connected}
				mobileOpen={mobileSidebarOpen}
				onCloseMobile={() => setMobileSidebarOpen(false)}
				onSelectSession={(sessionId) => {
					setActiveSessionId(sessionId);
					setMobileSidebarOpen(false);
				}}
				onCreateSession={(projectId) => void handleCreateSession(projectId)}
				onCreateProject={handleCreateProject}
				onDeleteProject={handleDeleteProject}
			/>
			<main className="chat-pane flex h-full min-w-0 flex-1 flex-col overflow-hidden">
				<WebHeader
					title={activeSession?.title || t("web.chooseSession")}
					status={headerStatus}
					onOpenSidebar={() => setMobileSidebarOpen(true)}
					model={activeSession?.model ?? pendingModel ?? undefined}
					thinkingLevel={activeSession?.thinkingLevel ?? pendingThinkingLevel ?? undefined}
					models={models}
					onModelChange={(model) => void handleModelChange(model)}
					onThinkingChange={(level) => void handleThinkingChange(level)}
				/>
				<WebTimeline
					messages={messages}
					hasActiveSession={Boolean(activeSession)}
					hasMoreHistory={hasMoreHistory}
					moreCount={moreCount}
					loadingMore={loadingMore}
					streaming={streaming}
					error={error?.message ?? commandError}
					onLoadMore={() => void handleLoadMore()}
				/>
				<WebComposer
					disabled={Boolean(creatingProjectId)}
					streaming={streaming}
					onSend={handleSend}
					onStop={handleStop}
				/>
			</main>
		</div>
	);
}
