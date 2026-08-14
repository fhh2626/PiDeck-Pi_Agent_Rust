/** 创建带有限重名后缀重试的 Prompt 模板。 */
export type UniquePromptCreator<T> = (name: string) => Promise<T>;

export type CreateUniquePromptOptions<T> = {
	baseName: string;
	create: UniquePromptCreator<T>;
	isAlreadyExists: (error: unknown) => boolean;
	maxAttempts?: number;
};

/** 计算下一次重名候选名；不会递归，避免永久写入失败时耗尽调用栈。 */
export function nextUniquePromptName(baseName: string, currentName: string): string {
	const match = currentName.match(/-(\d+)$/);
	const nextNumber = match ? Number(match[1]) + 1 : 2;
	const stem = currentName.replace(/-\d+$/, "") || baseName;
	return `${stem}-${nextNumber}`;
}

/** 只对明确的重名错误重试，其他创建错误立即返回给调用方。 */
export async function createUniquePrompt<T>(
	options: CreateUniquePromptOptions<T>,
): Promise<T> {
	const requestedAttempts = options.maxAttempts;
	const maxAttempts = typeof requestedAttempts === "number" &&
		Number.isSafeInteger(requestedAttempts) && requestedAttempts > 0
		? requestedAttempts
		: 32;
	let candidate = options.baseName;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			return await options.create(candidate);
		} catch (error: unknown) {
			if (!options.isAlreadyExists(error)) throw error;
			if (attempt + 1 >= maxAttempts) throw error;
			candidate = nextUniquePromptName(options.baseName, candidate);
		}
	}

	// maxAttempts 已保证循环至少执行一次；此处仅用于让 TypeScript 看到完整返回路径。
	throw new Error("Prompt creation attempts exhausted");
}
