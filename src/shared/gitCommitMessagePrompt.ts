/** Git commit message prompt defaults shared by the main and renderer processes. */
export type GitCommitMessagePromptLocale = "zh-CN" | "en-US";

export const DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN = `请根据以下 git diff 生成一条中文 git commit message。

变更描述：
{diff}

Gitmoji 对应关系：
✨ feat - 新功能
🐛 fix - Bug 修复
📚 docs - 文档更新
💎 style - 代码格式
♻️ refactor - 重构
🧪 test - 测试
🔧 chore - 构建/工具

要求：
1. 使用对应的 Gitmoji 开头
2. 第一行简要说明修改的模块和做了什么
3. 后续用 - 列出具体变更点
4. 直接输出 commit 消息，不要解释`;

export const DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US = `Please generate an English git commit message based on the following git diff.

Changes:
{diff}

Gitmoji mapping:
✨ feat - New feature
🐛 fix - Bug fix
📚 docs - Documentation update
💎 style - Code formatting
♻️ refactor - Refactoring
🧪 test - Tests
🔧 chore - Build/tooling

Requirements:
1. Start with the appropriate Gitmoji
2. The first line briefly describes the affected module and change
3. List specific changes on subsequent lines using -
4. Output only the commit message, without explanation`;

export function getDefaultGitCommitMessagePrompt(locale: GitCommitMessagePromptLocale): string {
	return locale === "en-US"
		? DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US
		: DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN;
}

/** Resolve the prompt language from an explicit app language and its system fallback. */
export function resolveGitCommitMessagePromptLocale(
	language: string | undefined,
	systemLanguage?: string,
): GitCommitMessagePromptLocale {
	const selectedLanguage = language && language !== "system" ? language : systemLanguage;
	const normalizedLanguage = selectedLanguage?.trim().replace(/_/g, "-").toLowerCase() ?? "";
	return normalizedLanguage === "pseudo" || normalizedLanguage.startsWith("en") ? "en-US" : "zh-CN";
}

/** Only replace built-in defaults; user-authored prompt templates remain untouched. */
export function isDefaultGitCommitMessagePrompt(prompt: string): boolean {
	return prompt.trim() === ""
		|| prompt === DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN
		|| prompt === DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US;
}
