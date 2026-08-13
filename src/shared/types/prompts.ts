// ── pi Prompt Templates ─────────────────────────────────────────────────

/** pi Prompt Template，对应 ~/.pi/agent/prompts/<name>.md */
export type PiPromptTemplateSummary = {
	name: string;
	path: string;
	description: string;
	content: string;
	userCreated: boolean;
	/** 模板范围：global (~/.pi/agent/prompts/) 或 project (.pi/prompts/) */
	scope?: "global" | "project";
};

export type PiPromptTemplateListResult = {
	templates: PiPromptTemplateSummary[];
	globalDir: string;
	/** 是否存在被用户删除、可通过「找回默认模板」恢复的内置项 */
	hasHiddenBuiltins: boolean;
};

export type CreatePiPromptTemplateInput = {
	name: string;
	description: string;
};

// ── Prompt Store (prompts.chat) ─────────────────────────────────────────

/** prompts.chat API 返回的原始 prompt 条目（完整字段） */
export interface PromptStoreRawItem {
	id: string;
	title: string;
	slug: string;
	description: string;
	content: string;
	type: string;
	author: { id: string; name: string; username: string; avatar?: string; verified?: boolean };
	category: { id: string; name: string; slug: string } | null;
	tags: Array<{ promptId: string; tagId: string; tag: { id: string; name: string; slug: string; color?: string } }>;
	voteCount: number;
	viewCount: number;
	createdAt: string;
}

/** UI 消费的扁平化 prompt 条目 */
export interface PromptStoreItem {
	id: string;
	title: string;
	description: string;
	content: string;
	type: string;
	author: string;
	category: string;
	tags: string[];
	votes: number;
	createdAt: string;
}

/** prompts.chat REST API 搜索响应（/api/prompts?q=...） */
export interface PromptStoreSearchResponse {
	prompts: PromptStoreRawItem[];
	total: number;
	page: number;
	perPage: number;
	totalPages: number;
}

/** IPC 返回给渲染进程的搜索结果 */
export interface PromptStoreSearchResult {
	query: string;
	count: number;
	prompts: PromptStoreItem[];
}

export type PromptStoreSearchType = "TEXT" | "STRUCTURED" | "IMAGE" | "VIDEO" | "AUDIO";

// ── Yao Open Prompts（中文提示词精选） ─────────────────────────────────

export type YaoPromptCategory = {
	slug: string;
	name: string;
	count: number;
};

export type YaoPromptItem = {
	/** 文件名（不含 .md） */
	slug: string;
	title: string;
	category: string;
	subcategory: string;
	tags: string[];
	description: string;
	/** 文件绝对路径 */
	path: string;
};

export type YaoPromptListResult = {
	categories: YaoPromptCategory[];
	prompts: YaoPromptItem[];
	repoPath: string;
	total?: number;
	page?: number;
	pageSize?: number;
};

export type YaoPromptDetailResult = {
	title: string;
	description: string;
	promptContent: string;
	fullContent: string;
};
