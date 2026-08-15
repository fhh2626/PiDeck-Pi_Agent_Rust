import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const prompt = readFileSync("src/shared/gitCommitMessagePrompt.ts", "utf8");
const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const rendererApp = readFileSync("src/renderer/src/App.tsx", "utf8");

test("Git commit prompt provides localized Chinese and English defaults", () => {
	assert.match(prompt, /DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_ZH_CN/);
	assert.match(prompt, /请根据以下 git diff 生成一条中文 git commit message/);
	assert.match(prompt, /DEFAULT_GIT_COMMIT_MESSAGE_PROMPT_EN_US/);
	assert.match(prompt, /Please generate an English git commit message/);
	assert.match(prompt, /resolveGitCommitMessagePromptLocale/);
});

test("Git commit prompt defaults are shared and custom templates are preserved", () => {
	assert.match(settingsStore, /getDefaultGitCommitMessagePrompt\("zh-CN"\)/);
	assert.match(settingsStore, /applyLocalizedDefaultGitCommitMessagePrompt/);
	assert.match(settingsStore, /!isDefaultGitCommitMessagePrompt\(persistedPrompt\)/);
	assert.match(settingsStore, /languageChanged && !promptProvided && promptWasDefault/);
	assert.match(gitIpc, /getDefaultGitCommitMessagePrompt\(/);
	assert.match(gitIpc, /resolveGitCommitMessagePromptLocale\(getLocale\(\)\)/);
	assert.match(rendererApp, /getDefaultGitCommitMessagePrompt\(/);
});
