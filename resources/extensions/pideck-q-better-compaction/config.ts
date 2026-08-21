import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_EXTENSION_CONFIG,
	EXTENSION_STORAGE_ID,
	LEGACY_EXTENSION_STORAGE_ID,
	MAX_COMPACT_MAX_ATTEMPTS,
	MAX_COMPACT_RETRY_DELAY_MS,
	MAX_COMPACT_TIMEOUT_MS,
	MIN_COMPACT_MAX_ATTEMPTS,
	MIN_COMPACT_RETRY_DELAY_MS,
	MIN_COMPACT_TIMEOUT_MS,
	THINKING_LEVELS,
	type ExtensionConfig,
	type LoadedExtensionConfig,
} from "./types";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", EXTENSION_STORAGE_ID);
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const LEGACY_CONFIG_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"extensions",
	LEGACY_EXTENSION_STORAGE_ID,
	"config.json",
);

/** Prefer the renamed config path while retaining a read-only legacy fallback. */
export function resolveConfigReadPath(
	requestedPath: string,
	defaultPath: string = CONFIG_PATH,
	legacyPath: string = LEGACY_CONFIG_PATH,
	fileExists: (filePath: string) => boolean = isFile,
): string {
	return requestedPath === defaultPath && !fileExists(defaultPath) && fileExists(legacyPath)
		? legacyPath
		: requestedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function isFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readJsonObject(filePath: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!isFile(filePath)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`Ignoring ${filePath}: expected a JSON object at the top level.`);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Ignoring ${filePath}: ${message}`);
		return undefined;
	}
}

function resolveConfiguredPath(rawPath: string, baseDir: string): string {
	if (rawPath.startsWith("~/")) {
		return path.join(os.homedir(), rawPath.slice(2));
	}
	if (path.isAbsolute(rawPath)) {
		return path.resolve(rawPath);
	}
	return path.resolve(baseDir, rawPath);
}

function toBoolean(value: unknown, fieldPath: string, warnings: string[]): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	warnings.push(`Ignoring ${fieldPath}: expected a boolean.`);
	return undefined;
}

function toInteger(value: unknown, fieldPath: string, warnings: string[]): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	warnings.push(`Ignoring ${fieldPath}: expected an integer.`);
	return undefined;
}

function clampInteger(
	value: number,
	fieldPath: string,
	min: number,
	max: number,
	warnings: string[],
): number {
	if (value < min || value > max) {
		warnings.push(`Clamping ${fieldPath}=${value} to the range [${min}, ${max}].`);
	}
	return Math.min(max, Math.max(min, value));
}

function toModelSpec(value: unknown, fieldPath: string, warnings: string[]): string | null | undefined {
	if (value === undefined) return undefined;
	// Explicit null clears a spec, matching the documented "unset = current model" behavior.
	if (value === null) return null;
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim();
	}
	warnings.push(`Ignoring ${fieldPath}: expected "provider/model-id" or null.`);
	return undefined;
}

function toThinkingLevel(value: unknown, fieldPath: string, warnings: string[]): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ThinkingLevel;
	}
	warnings.push(`Ignoring ${fieldPath}: expected one of ${THINKING_LEVELS.join(", ")}.`);
	return undefined;
}

/**
 * Load extension config from the renamed directory. When the new default path
 * is absent, the legacy path remains readable so existing users keep their settings.
 */
export function loadExtensionConfig(configPath: string = CONFIG_PATH): LoadedExtensionConfig {
	const warnings: string[] = [];
	const resolved: ExtensionConfig = {
		...DEFAULT_EXTENSION_CONFIG,
	};
	let source: string | undefined;

	const effectiveConfigPath = resolveConfigReadPath(configPath);
	const raw = readJsonObject(effectiveConfigPath, warnings);
	if (raw) {
		source = effectiveConfigPath;

		resolved.enabled = toBoolean(raw.enabled, "enabled", warnings) ?? resolved.enabled;
		resolved.notifyOnLoad = toBoolean(raw.notifyOnLoad, "notifyOnLoad", warnings) ?? resolved.notifyOnLoad;
		resolved.debug = toBoolean(raw.debug, "debug", warnings) ?? resolved.debug;
		resolved.redactSensitiveData =
			toBoolean(raw.redactSensitiveData, "redactSensitiveData", warnings) ?? resolved.redactSensitiveData;

		const modelSpec = toModelSpec(raw.compactionModel, "compactionModel", warnings);
		if (modelSpec !== undefined) {
			resolved.compactionModel = modelSpec === null ? undefined : modelSpec;
		}

		resolved.compactionThinkingLevel =
			toThinkingLevel(raw.compactionThinkingLevel, "compactionThinkingLevel", warnings) ??
			resolved.compactionThinkingLevel;

		const timeoutMs = toInteger(raw.compactTimeoutMs, "compactTimeoutMs", warnings);
		if (timeoutMs !== undefined) {
			if (timeoutMs === 0) {
				resolved.compactTimeoutMs = 0;
			} else {
				resolved.compactTimeoutMs = clampInteger(
					timeoutMs,
					"compactTimeoutMs",
					MIN_COMPACT_TIMEOUT_MS,
					MAX_COMPACT_TIMEOUT_MS,
					warnings,
				);
			}
		}

		const maxAttempts = toInteger(raw.compactMaxAttempts, "compactMaxAttempts", warnings);
		if (maxAttempts !== undefined) {
			resolved.compactMaxAttempts = clampInteger(
				maxAttempts,
				"compactMaxAttempts",
				MIN_COMPACT_MAX_ATTEMPTS,
				MAX_COMPACT_MAX_ATTEMPTS,
				warnings,
			);
		}

		const retryDelayMs = toInteger(raw.compactRetryDelayMs, "compactRetryDelayMs", warnings);
		if (retryDelayMs !== undefined) {
			resolved.compactRetryDelayMs = clampInteger(
				retryDelayMs,
				"compactRetryDelayMs",
				MIN_COMPACT_RETRY_DELAY_MS,
				MAX_COMPACT_RETRY_DELAY_MS,
				warnings,
			);
		}

		if (typeof raw.artifactRoot === "string" && raw.artifactRoot.trim().length > 0) {
			resolved.artifactRoot = raw.artifactRoot.trim();
		} else if (raw.artifactRoot !== undefined) {
			warnings.push("Ignoring artifactRoot: expected a non-empty string.");
		}
	}

	resolved.artifactRoot = resolveConfiguredPath(resolved.artifactRoot, path.dirname(effectiveConfigPath));

	return {
		config: resolved,
		source,
		warnings,
	};
}
