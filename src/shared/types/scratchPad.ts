/** 草稿元信息，对应 drafts 目录中的单个 Markdown 文件。 */
export type DraftMeta = {
	id: string;
	name: string;
	path: string;
	createdAt: number;
	updatedAt: number;
};

/** 草稿正文与编辑器恢复状态。 */
export type ScratchPadData = {
	content: string;
	lastEditedAt: number;
	cursorPosition: number;
};
