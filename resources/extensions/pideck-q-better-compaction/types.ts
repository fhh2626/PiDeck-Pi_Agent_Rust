import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EXTENSION_ID = "PiDeck-Q-Better-Compaction";
export const EXTENSION_STORAGE_ID = "pideck-q-better-compaction";
export const LEGACY_EXTENSION_STORAGE_ID = "pi-better-compaction";
export const DEFAULT_ARTIFACT_ROOT = "~/.pi/agent/artifacts/pideck-q-better-compaction";
export const REDACTED_VALUE = "[REDACTED]";
/**
 * APIs the extension can summarize through a regular Responses request.
 * `responsesCompactApis` is retained as the configuration key for compatibility.
 */
export const RESPONSES_COMPACT_CAPABLE_APIS = ["openai-responses", "openai-codex-responses"] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Minimum (and default) per-attempt native compact timeout in ms. */
export const MIN_COMPACT_TIMEOUT_MS = 300_000;
/** Maximum per-attempt native compact timeout in ms. */
export const MAX_COMPACT_TIMEOUT_MS = 900_000;
/** Minimum (and default) attempts for the same original-path compaction call. */
export const MIN_COMPACT_MAX_ATTEMPTS = 2;
/** Maximum attempts for the same original-path compaction call. */
export const MAX_COMPACT_MAX_ATTEMPTS = 3;
/** Minimum retry delay between compaction attempts in ms. */
export const MIN_COMPACT_RETRY_DELAY_MS = 0;
/** Maximum retry delay between compaction attempts in ms. */
export const MAX_COMPACT_RETRY_DELAY_MS = 10_000;

export type DebugArtifactKind =
	| "compact-response"
	| "compaction-event"
	| "lifecycle";

export type ExtensionConfig = {
	enabled: boolean;
	/**
	 * "provider/model-id" used for native-method fallback compaction on non-Responses
	 * APIs. Unset = current model via pi's default path.
	 */
	compactionModel?: string;
	/** Thinking level passed to pi's native compact() when the fallback model runs. */
	compactionThinkingLevel: ThinkingLevel;
	/** Subset of Responses APIs that should use direct prompt-based summarization. */
	responsesCompactApis: string[];
	/** Per-attempt timeout for Responses summary and configured-model compact(). 0 = none. */
	compactTimeoutMs: number;
	/** Max attempts for the same original-path compaction call. */
	compactMaxAttempts: number;
	/** Delay between attempts. */
	compactRetryDelayMs: number;
	notifyOnLoad: boolean;
	debug: boolean;
	logCompactResponses: boolean;
	redactSensitiveData: boolean;
	artifactRoot: string;
};

export type LoadedExtensionConfig = {
	config: ExtensionConfig;
	/** Path of the config file that was applied, if it existed and parsed. */
	source?: string;
	warnings: string[];
};

export type ArtifactPaths = {
	rootDir: string;
	sessionDir: string;
	compactResponsesDir: string;
	compactionDir: string;
	lifecycleDir: string;
};

export type ArtifactSessionInfo = {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
};

export type ArtifactContext = ArtifactSessionInfo | Pick<ExtensionContext, "cwd" | "sessionManager">;

export type DebugArtifactEnvelope = {
	extension: string;
	kind: DebugArtifactKind;
	timestamp: string;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	redaction: {
		enabled: boolean;
	};
	data: unknown;
};

export type RedactOptions = {
	placeholder?: string;
};

export const DEFAULT_EXTENSION_CONFIG: ExtensionConfig = {
	enabled: true,
	compactionModel: undefined,
	compactionThinkingLevel: "off",
	responsesCompactApis: [...RESPONSES_COMPACT_CAPABLE_APIS],
	compactTimeoutMs: MIN_COMPACT_TIMEOUT_MS,
	compactMaxAttempts: MIN_COMPACT_MAX_ATTEMPTS,
	compactRetryDelayMs: 1_500,
	notifyOnLoad: false,
	debug: false,
	logCompactResponses: false,
	redactSensitiveData: true,
	artifactRoot: DEFAULT_ARTIFACT_ROOT,
};
