import { resolve } from "node:path";
import { isPathInsideRoot } from "../security/policy";

export const FILE_PATH_NOT_AUTHORIZED_CODE = "FILE_PATH_NOT_AUTHORIZED";

export class UnauthorizedFilePathError extends Error {
	readonly code = FILE_PATH_NOT_AUTHORIZED_CODE;

	constructor(operation: string) {
		super(`File path is not authorized for ${operation}.`);
		this.name = "UnauthorizedFilePathError";
	}
}

/** 判断规范化后的路径是否位于任一授权根目录内。 */
export function isPathWithinAuthorizedRoots(target: string, roots: readonly string[]): boolean {
	if (!target || roots.length === 0) return false;
	const normalizedTarget = resolve(target);
	return roots.some((root) => root.length > 0 && isPathInsideRoot(normalizedTarget, resolve(root)));
}

/** 校验文件边界并返回规范化路径，供主进程后续 filesystem 调用复用。 */
export function assertAuthorizedFilePath(
	target: string,
	roots: readonly string[],
	operation: string,
): string {
	const normalizedTarget = resolve(target);
	if (!isPathWithinAuthorizedRoots(normalizedTarget, roots)) {
		throw new UnauthorizedFilePathError(operation);
	}
	return normalizedTarget;
}
