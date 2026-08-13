export const ipcChannels = {
	projectsList: "projects:list",
	projectsAdd: "projects:add",
	projectsRemove: "projects:remove",
	projectsReorder: "projects:reorder",
	projectsChanged: "projects:changed",
	projectResourcesList: "project-resources:list",
	projectResourcesCreateSkill: "project-resources:create-skill",
	projectResourcesDeleteSkill: "project-resources:delete-skill",
	projectResourcesToggleSkill: "project-resources:toggle-skill",
	projectResourcesDeleteExtension: "project-resources:delete-extension",
	projectResourcesToggleExtension: "project-resources:toggle-extension",
	projectResourcesRenameSkill: "project-resources:rename-skill",
	projectsListRoot: "projects:list-root",
	projectsListWorktreeChildren: "projects:list-worktree-children",
	projectsToggleWorktreeEnabled: "projects:toggle-worktree-enabled",
	// 选择聊天记录目录（系统文件选择器，默认当前聊天目录）
	projectsChooseChatPath: "projects:choose-chat-path",
	// 设置聊天记录目录并持久化
	projectsSetChatPath: "projects:set-chat-path",
	editorsList: "editors:list",
	editorsRedetect: "editors:redetect",
	editorsUpdate: "editors:update",
	editorsChooseExecutable: "editors:choose-executable",
	editorsOpenProject: "editors:open-project",
	filesList: "files:list",
	filesOpen: "files:open",
	filesShowInFolder: "files:show-in-folder",
	filesReadContent: "files:read-content",
	filesWriteContent: "files:write-content",
	filesCreate: "files:create",
	filesDelete: "files:delete",
	filesRename: "files:rename",
	/** 复制来源路径到目标目录（支持文件和目录递归） */
	filesCopy: "files:copy",
	/** 移动来源路径到目标目录（同设备 rename，跨设备 cp+rm） */
	filesMove: "files:move",
	/** 读取文件返回 base64 编码的数据 URL，用于图片等二进制文件 */
	filesReadBase64: "files:read-base64",
	sessionsList: "sessions:list",
	/** Session-first catalog APIs. */
	sessionsCatalogList: "sessions:catalog-list",
	/** 后台扫描完成后主进程 → 渲染层的推送（目录缓存已合并，渲染层应重新拉取）。 */
	sessionsCatalogRefreshed: "sessions:catalog-refreshed",
	sessionsCatalogCreateDraft: "sessions:catalog-create-draft",
	/** Starts an in-memory `--no-session` conversation. */
	sessionsCreateAnonymous: "sessions:create-anonymous",
	sessionsCatalogUpdate: "sessions:catalog-update",
	sessionsCatalogDelete: "sessions:catalog-delete",
	/** 归档会话：文件移入 .pideck-archive/ 并从目录移除 */
	sessionsCatalogArchive: "sessions:catalog-archive",
	/** 恢复归档会话：移回原路径并重新入目录 */
	sessionsCatalogUnarchive: "sessions:catalog-unarchive",
	/** 列出已归档会话摘要（恢复 UI 用） */
	sessionsCatalogListArchived: "sessions:catalog-list-archived",
	sessionsCatalogReadMessages: "sessions:catalog-read-messages",
	sessionsCatalogReadMessagePage: "sessions:catalog-read-message-page",
	sessionsCatalogReadReferenceMessages: "sessions:catalog-read-reference-messages",
	/** 按需读取单条消息完整文本（工具结果截断后的「查看完整输出」入口）。 */
	sessionsCatalogReadMessageFullText: "sessions:catalog-read-message-full-text",
	sessionsCatalogCopy: "sessions:catalog-copy",
	sessionsCatalogExportHtml: "sessions:catalog-export-html",
	sessionsSendPrompt: "sessions:send-prompt",
	sessionsRuntimeEvent: "sessions:runtime-event",
	sessionsUiResponse: "sessions:ui-response",
	sessionsRuntimeList: "sessions:runtime-list",
	sessionsRuntimeActivate: "sessions:runtime-activate",
	sessionsRuntimeStop: "sessions:runtime-stop",
	sessionsRuntimeAbort: "sessions:runtime-abort",
	sessionsRuntimeRestart: "sessions:runtime-restart",
	sessionsRuntimeCompact: "sessions:runtime-compact",
	sessionsRuntimeState: "sessions:runtime-state",
	sessionsRuntimeCommands: "sessions:runtime-commands",
	sessionsRuntimeExportHtml: "sessions:runtime-export-html",
	sessionsRuntimeEditMessage: "sessions:runtime-edit-message",
	sessionsRuntimeDeleteMessage: "sessions:runtime-delete-message",
	sessionsRuntimePrepareResend: "sessions:runtime-prepare-resend",
	sessionsRuntimeSetModel: "sessions:runtime-set-model",
	sessionsRuntimeSetThinking: "sessions:runtime-set-thinking",
	sessionsRuntimeClone: "sessions:runtime-clone",
	// 从用户消息 fork 新会话（pi /fork）；与 clone 不同，会按 entryId 裁剪会话树
	sessionsRuntimeGetForkMessages: "sessions:runtime-get-fork-messages",
	sessionsRuntimeFork: "sessions:runtime-fork",
	/** 渲染层汇报当前聚焦的会话（用于非聚焦会话 Ask 请求的桌面通知） */
	sessionsSetFocusedSession: "sessions:set-focused-session",
	codexSessionsScan: "codex-sessions:scan",
	codexSessionsImport: "codex-sessions:import",
	claudeSessionsScan: "claude-sessions:scan",
	claudeSessionsImport: "claude-sessions:import",
	openCodeSessionsScan: "opencode-sessions:scan",
	openCodeSessionsImport: "opencode-sessions:import",
	settingsGet: "settings:get",
	settingsUpdate: "settings:update",
	/** 重启当前已启用的 Web 服务，不修改 Web 设置 */
	settingsRestartWebService: "settings:restart-web-service",
	settingsTestPiProxy: "settings:test-pi-proxy",
	settingsApplyWindow: "settings:apply-window",
	skillsList: "skills:list",
	skillsCreate: "skills:create",
	skillsToggle: "skills:toggle",
	skillsDelete: "skills:delete",
	skillsOpenFolder: "skills:open-folder",
	skillsRename: "skills:rename",
	promptsList: "prompts:list",
	promptsCreate: "prompts:create",
	promptsDelete: "prompts:delete",
	promptsOpenFolder: "prompts:open-folder",
	promptsRestoreBuiltins: "prompts:restore-builtins",
	promptsEdit: "prompts:edit",
	promptsListByProject: "prompts:list-by-project",
	promptsCreateInProject: "prompts:create-in-project",
	promptsDeleteInProject: "prompts:delete-in-project",
	promptsRename: "prompts:rename",
	promptsRenameInProject: "prompts:rename-in-project",
	promptStoreSearch: "prompt-store:search",
	promptStoreGet: "prompt-store:get",
	promptStoreImport: "prompt-store:import",
	yaoPromptsList: "yao-prompts:list",
	yaoPromptsDetail: "yao-prompts:detail",
	yaoPromptsImport: "yao-prompts:import",
	skillStoreSearch: "skill-store:search",
	skillStoreGet: "skill-store:get",
	skillStoreImport: "skill-store:import",
	// SkillHub（api.skillhub.cn）
	skillHubSearch: "skill-hub:search",
	skillHubDetail: "skill-hub:detail",
	skillHubInstall: "skill-hub:install",
	extensionsList: "extensions:list",
	extensionsUninstall: "extensions:uninstall",
	extensionsInstall: "extensions:install",
	extensionsToggle: "extensions:toggle",
	extensionsRemoveBuiltIn: "extensions:remove-built-in",
	extensionsRestoreBuiltIn: "extensions:restore-built-in",
	extensionsUpdate: "extensions:update",
	extensionsUpdateOne: "extensions:update-one",
	gitBranches: "git:branches",
	gitCheckout: "git:checkout",
	gitCreateBranch: "git:create-branch",
	gitOriginalContent: "git:original-content",
	gitWorktreeList: "git:worktree-list",
	gitWorktreeCreate: "git:worktree-create",
	gitWorktreeRemove: "git:worktree-remove",
	gitCommitLog: "git:commit-log",
	gitRefs: "git:refs",
	gitBranchCompare: "git:branch-compare",
	gitCommitDetail: "git:commit-detail",
	gitCommitFileDiff: "git:commit-file-diff",
	gitDiffFileBetween: "git:diff-file-between",
	gitStatus: "git:status",
	gitWorkspaceFileDiff: "git:workspace-file-diff",
	gitStage: "git:stage",
	gitUnstage: "git:unstage",
	gitDiscard: "git:discard",
	gitCommit: "git:commit",
	gitCherryPick: "git:cherry-pick",
	gitRevert: "git:revert",
	gitPush: "git:push",
	gitPull: "git:pull",
	gitReset: "git:reset",
	gitDropCommit: "git:drop-commit",
	gitGenerateCommitMessage: "git:generate-commit-message",
	gitInit: "git:init",
	gitFetch: "git:fetch",
	/** 当前分支相对上游的提交差距（ahead/behind），驱动 push/pull 角标 */
	gitAheadBehind: "git:ahead-behind",
	/** 从磁盘删除变更文件（移入回收站，可恢复） */
	gitDeleteFiles: "git:delete-files",
	piCheck: "pi:check",
	piCheckCustom: "pi:check-custom",
	/** 获取已安装的 WSL 发行版列表（仅 Windows） */
	wslListDistros: "wsl:list-distros",
	/** 验证 WSL 连接：检查 distro + user 是否可达，以及 pi 是否已安装 */
	wslValidateConnection: "wsl:validate-connection",
	piUpdateCheck: "pi:update-check",
	piUpdate: "pi:update",
	/** 在系统终端中执行安装命令（npm install）并返回结果 */
	piExecInstall: "pi:exec-install",
	/** 检查 npm 是否可用 */
	piCheckNpm: "pi:check-npm",
	appInfo: "app:info",
	/** 获取当前机器的非回环 IPv4 网卡，供局域网 Web 服务二维码使用 */
	appNetworkAddresses: "app:network-addresses",
	appPreferredSystemLanguages: "app:preferred-system-languages",
	appCheckUpdate: "app:check-update",
	appDownloadUpdate: "app:download-update",
	appInstallUpdate: "app:install-update",
	appUpdateProgress: "app:update-progress",
	appFeedbackEnvironment: "app:feedback-environment",
	appOpenExternal: "app:open-external",
	appOpenInBrowser: "app:open-in-browser",
	appRestart: "app:restart",
	/** 进程监控：拉取 Electron 各进程 + pi agent 子进程的内存/CPU 快照 */
	processMetrics: "system:process-metrics",
	/** 进程监控里手动停止某个 pi agent（按 agentId 走 AgentManager 正常停止流程） */
	stopAgent: "system:stop-agent",
	preloadReady: "preload:ready",
	preloadError: "preload:error",
	rendererLog: "renderer:log",
	logsList: "logs:list",
	logsListPage: "logs:list-page",
	logsClear: "logs:clear",
	logsOpenFolder: "logs:open-folder",
	/** 获取 app 日志文件总大小 */
	logsSize: "logs:get-size",
	/** 获取 RPC 日志文件总大小 */
	rpcLogsGetSize: "rpc-logs:get-size",
	/** 从文件读取 RPC 日志 */
	rpcLogsGet: "rpc-logs:get",
	/** 读取主进程实时环形缓冲（最近 N 条） */
	rpcLogsGetLive: "rpc-logs:get-live",
	/** 将弹窗条目合并写入自动日志文件（按 id 去重） */
	rpcLogsSave: "rpc-logs:save",
	/** 清空 RPC 日志 */
	rpcLogsClear: "rpc-logs:clear",
	rpcLoggingSet: "rpc-logs:logging-set",
	rpcLoggingGet: "rpc-logs:logging-get",

	appWindowMinimize: "app:window-minimize",
	appWindowToggleMaximize: "app:window-toggle-maximize",
	appWindowIsMaximized: "app:window-is-maximized",
	/** 主进程 → 渲染：最大化状态变化（含双击标题栏等非按钮路径） */
	appWindowMaximizedChanged: "app:window-maximized-changed",
	appWindowToggleAlwaysOnTop: "app:window-toggle-always-on-top",
	appWindowClose: "app:window-close",
	agentsRuntimeState: "agents:runtime-state",
	agentsState: "agents:state",
	projectsListModels: "projects:list-models",
	/** 模型规格查询：线上缓存（OpenRouter + models.dev）按模型 id 匹配，中转站通用 */
	projectsGetModelSpec: "projects:get-model-spec",
	/** 手动刷新云端模型规格缓存 */
	projectsRefreshModelSpecs: "projects:refresh-model-specs",
	agentsEvent: "agents:event",
	agentsMessage: "agents:message",
	agentsLog: "agents:log",

	/** 流式思考内容更新，agent 忙碌时实时推送当前思考文本 */
	agentsThinking: "agents:thinking",

	/** 流式正文内容更新，agent 忙碌时实时推送累积正文（阶段1：独立于 messages 数组） */
	agentsTextStream: "agents:text-stream",

	/**
	 * 主进程 → 渲染进程的轻量 toast 通知（如 abort 已请求停止）。
	 * 避免把瞬时状态反馈写成会话时间线里的系统卡片。
	 */
	agentsNotice: "agents:notice",

	/** Agent Extension UI 协议：主进程 → 渲染进程，推送扩展的 UI 请求（select/confirm/input/editor） */
	agentsUiRequest: "agents:ui-request",
	/** 项目信任确认：主进程 → 渲染进程，启动 Agent 前请求用户对含 .pi 资源的项目做信任决策 */
	projectsTrustRequest: "projects:trust-request",
	/** 项目信任确认：渲染进程 → 主进程，回传用户的信任选择（trust-remember/trust-session/deny） */
	projectsTrustResponse: "projects:trust-response",

	configGetModels: "config:get-models",
	configGetAuth: "config:get-auth",
	configGetSettings: "config:get-settings",
	configGetTrust: "config:get-trust",
	configSaveModels: "config:save-models",
	configSaveAuth: "config:save-auth",
	configSaveSettings: "config:save-settings",
	configSaveRaw: "config:save-raw",
	configExport: "config:export",
	configImport: "config:import",
	/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
	configFetchModels: "config:fetch-models",
	/** 快速测试 provider 连接：发送一条最小请求验证 baseUrl/apiKey/模型 是否正常 */
	configTestProvider: "config:test-provider",

	// ===== 安全管理（SecurityStore + pi-deck-security-gate 扩展） =====
	/** 拉取完整安全配置（等级/默认等级/会话覆盖） */
	securityGetConfig: "security:get-config",
	/** 更新安全配置（校验 + 持久化 + 刷新策略快照） */
	securityUpdateConfig: "security:update-config",
	/** 设置单个会话的等级覆盖（levelId 为空 = 清除覆盖跟随全局） */
	securitySetSessionLevel: "security:set-session-level",

	/** 视觉桥：读取当前配置 + 可选模型列表 */
	visionGetConfig: "vision:get-config",
	/** 视觉桥：保存配置到 ~/.pi/agent/pi-deck-vision.json */
	visionSaveConfig: "vision:save-config",
	/** 视觉桥：读取运行日志（扩展写的 pi-deck-vision.log，诊断用） */
	visionGetLog: "vision:get-log",
	/** 视觉桥：读取结构化转换事件（pi-deck-vision-events.jsonl 尾部，会话渲染层展示请求详情） */
	visionGetEvents: "vision:get-events",
	/** 视觉桥：清空事件文件 */
	visionClearEvents: "vision:clear-events",
	/** 视觉桥：清空运行日志 */
	visionClearLog: "vision:clear-log",

	/** 切换开发者控制台 */
	appToggleDevTools: "app:toggle-devtools",

	/** RPC 日志，用于调试 */
	agentsRpcLog: "agents:rpc-log",

	terminalList: "terminal:list",
	terminalEnsure: "terminal:ensure",
	terminalCreate: "terminal:create",
	terminalInput: "terminal:input",
	terminalResize: "terminal:resize",
	terminalClose: "terminal:close",
	terminalData: "terminal:data",
	terminalExit: "terminal:exit",
	terminalShells: "terminal:shells",

	// ===== 桌面宠物（全局聚合单宠） =====
	/** 主进程 → 宠物窗：推送聚合状态 */
	petState: "pet:state",
	/** 宠物窗/设置页 → 主进程：列出可用宠物包 */
	petList: "pet:list",
	/** 设置页 → 主进程：开关宠物 */
	petSetEnabled: "pet:set-enabled",
	/** 设置页 → 主进程：切换当前宠物 */
	petSetId: "pet:set-id",
	/** 宠物窗 → 主进程：拖拽移动窗口位置 */
	petMoveWindow: "pet:move-window",
	/** 宠物窗 → 主进程：拖拽相对位移（连续 screenX 差值，避免 DPI 坐标单位混用） */
	petMoveBy: "pet:move-by",
	/** 宠物窗 → 主进程：点击宠物跳转活跃 Agent */
	petFocusAgent: "pet:focus-agent",
	/** 主进程 → 主窗口：点击宠物后通知主窗切换到活跃 Agent tab */
	petFocusAgentTarget: "pet:focus-agent-target",
	/** 主进程 → 宠物窗：推送当前选中宠物的 manifest（含 spritesheetUrl），切换宠物时热加载 */
	petCurrentSprite: "pet:current-sprite",
	/** 宠物窗 → 主进程：拉取当前选中宠物的 manifest（挂载时主动拉取，避免推送竞态丢失） */
	petGetCurrent: "pet:get-current",
	/** 主进程 → 宠物窗：推送通知气泡（出错/完成时宠物头顶弹窗） */
	petNotify: "pet:notify",
	/** 设置页 → 主进程 → 宠物窗：预览动画行（测试用） */
	petPreviewMode: "pet:preview-mode",
	/** 主进程 → 宠物窗：推送窗口能力探测结果（透明/穿透/自由定位） ★ 降级形态渲染 */
	petCaps: "pet:caps",
	/** 宠物窗 → 主进程：双击宠物触发逗弄（注入一次 jumping 后恢复真实态） */
	petTease: "pet:tease",
	/** 宠物窗 → 主进程：拖拽起止通知（开始时暂停巡游，避免松手后 tick 命中反向边界瞬移） */
	petDragState: "pet:drag-state",
	/** 宠物窗 → 主进程：React 已挂载且 IPC 监听器已注册，主进程可安全推送初始状态 */
	petReady: "pet:ready",
	/** 宠物窗 → 主进程：请求显示右键上下文菜单 */
	petContextMenu: "pet:context-menu",

	// ===== Scratch Pad（草稿本/多草稿） =====
	scratchPadList: "scratch-pad:list",
	scratchPadCreate: "scratch-pad:create",
	scratchPadDelete: "scratch-pad:delete",
	scratchPadLoad: "scratch-pad:load",
	scratchPadSave: "scratch-pad:save",
	scratchPadExport: "scratch-pad:export",

	// ── 调试工具 ──
	/** 设置面板 → 主进程：发送测试通知（调试弹窗样式） */
	petTestNotify: "pet:test-notify",

	// ===== 系统文件选择器 =====
	dialogPickFiles: "dialog:pick-files",
	/** 换肤背景图：选图复制到 userData/backgrounds/（返回文件名，空串=取消） */
	pickBackgroundImage: "backgrounds:pick",
	/** 删除背景图文件 */
	removeBackgroundImage: "backgrounds:remove",

	// ===== 内置浏览器 =====
	browserOpenExternal: "browser:open-external",

	// ===== 用量统计（usage-stats） =====
	usageStatsDetect: "usage-stats:detect",
	usageStatsRefresh: "usage-stats:refresh",
	usageStatsGet: "usage-stats:get",

} as const;
