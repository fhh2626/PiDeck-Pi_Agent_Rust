/**
 * 日志文件行缓存（纯逻辑，无 electron 依赖，可单测）。
 *
 * 背景：设置页「存储与日志」tab 的 LogViewer 每次激活都会 listPage 一次，
 * 主进程要读全部日志文件（最多 MAX_LOG_FILES 个）。App 日志按天写入——
 * 历史文件写入后不再变化，只有当天文件持续 append。按 mtime+size 指纹缓存
 * 历史文件的行，查询时只重读变化文件，避免每次进 tab 都全量读盘。
 *
 * 缓存策略：
 * - 指纹 = mtimeMs + size（stat 元数据，不读内容）；指纹未变 → 复用行；
 * - 缓存按文件数设上限（FIFO 淘汰），防长期运行内存膨胀；
 * - 每文件保留尾部 maxLinesPerFile 行（与 AppLogger 既有防御上限一致）。
 */

export type LogLineCacheDeps = {
	readFile: (path: string) => Promise<string>;
	stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
};

type CachedLines = { fingerprint: string; lines: string[] };

async function fileFingerprint(
	stat: LogLineCacheDeps["stat"],
	path: string,
): Promise<string> {
	try {
		const s = await stat(path);
		return `${s.mtimeMs}:${s.size}`;
	} catch {
		return "missing";
	}
}

export class LogLineCache {
	private readonly deps: LogLineCacheDeps;
	private readonly maxFiles: number;
	private readonly maxLinesPerFile: number;
	private readonly cache = new Map<string, CachedLines>();

	constructor(deps: LogLineCacheDeps, maxFiles = 32, maxLinesPerFile = 200_000) {
		this.deps = deps;
		this.maxFiles = maxFiles;
		this.maxLinesPerFile = maxLinesPerFile;
	}

	/** 文件的尾部行（指纹未变时零 IO 复用缓存）。 */
	async linesOf(filePath: string): Promise<string[]> {
		const fingerprint = await fileFingerprint(this.deps.stat, filePath);
		const hit = this.cache.get(filePath);
		if (hit && hit.fingerprint === fingerprint) {
			return hit.lines;
		}
		const raw = await this.deps.readFile(filePath).catch(() => "");
		const lines = raw.split(/\r?\n/).filter(Boolean).slice(-this.maxLinesPerFile);
		this.cache.set(filePath, { fingerprint, lines });
		this.evictIfNeeded();
		return lines;
	}

	/** 清空缓存（日志被清除后调用，防止旧行残留）。 */
	clear(): void {
		this.cache.clear();
	}

	private evictIfNeeded(): void {
		if (this.cache.size <= this.maxFiles) return;
		const oldest = this.cache.keys().next().value;
		if (oldest !== undefined) this.cache.delete(oldest);
	}
}
