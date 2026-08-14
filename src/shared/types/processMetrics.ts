/**
 * 进程内存监控快照类型。
 *
 * 只监控 pi agent 子进程：Electron 自身进程的内存由用户自行在系统任务管理器
 * /活动监视器中查看（Electron 各进程的内存口径因平台/Chromium 版本而异，
 * 内置监控容易与任务管理器对不上，徒增困惑）。
 * agent 子进程不在 app metrics 里，由主进程按 pid 调系统命令查询内存
 * （Windows PowerShell PrivateMemorySize64 / Linux·macOS `ps -o rss`），缺失时为 undefined。
 */
export type AgentProcessMetric = {
	/** pi agent 会话标识（AgentManager 内唯一） */
	agentId: string;
	/** 关联的会话 id（可点击跳转）；匿名/终端 agent 无绑定时为 undefined */
	sessionId?: string;
	/** 关联会话标题（catalog 有记录时提供，展示用） */
	sessionTitle?: string;
	/** agent 子进程 pid */
	pid: number;
	/** 常驻内存（字节）；系统命令采样失败时 undefined */
	memoryBytes?: number;
	/** 该进程采样失败的原因（非致命，仅展示用） */
	error?: string;
};

export type ProcessMetricsSnapshot = {
	/** 正在运行的 pi agent 子进程 */
	agents: AgentProcessMetric[];
	/** pi agents 已采样内存之和（字节，失败项不计；Windows 为专用内存，其余平台 RSS） */
	totalAgentBytes: number;
	/** 快照采样时间戳（ms） */
	sampledAt: number;
};
