import type { AvailableModel } from "./types/agent";

/** Pi implementation selected by PiDeck. */
export type PiRuntimeKind = "typescript" | "rust" | "unknown";

/** User preference for selecting an installed Pi implementation. */
export type PiRuntimePreference = "auto" | "typescript" | "rust";

/**
 * Rust Pi prefixes its version with `pi`, while the TypeScript CLI currently
 * prints a bare semver. Keep this deliberately conservative: an unrecognised
 * version must remain usable in auto mode instead of being misclassified.
 */
export function detectPiRuntimeKind(version: string): PiRuntimeKind {
	const value = typeof version === "string" ? version.trim() : "";
	if (/^pi\s+v?\d+\.\d+\.\d+\b/i.test(value)) return "rust";
	if (/^v?\d+\.\d+\.\d+\b/.test(value)) return "typescript";
	return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Convert either Pi implementation's RPC model payload to PiDeck's narrow
 * model contract. The Rust payload calls image capabilities `input`, while
 * older Pi payloads may expose `images` directly.
 */
export function normalizePiRpcModels(data: unknown): AvailableModel[] {
	const container = asRecord(data);
	if (!container || !Array.isArray(container.models)) return [];

	const models: AvailableModel[] = [];
	const seen = new Set<string>();
	for (const item of container.models) {
		const raw = asRecord(item);
		if (!raw) continue;
		const provider = stringValue(raw.provider);
		const id = stringValue(raw.id ?? raw.modelId);
		if (!provider || !id) continue;

		const key = `${provider}\u0000${id}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);

		const input = Array.isArray(raw.input) ? raw.input : [];
		const images = typeof raw.images === "boolean"
			? raw.images
			: input.some((value) => value === "image");
		const hasImageCapability = typeof raw.images === "boolean" || input.length > 0;
		const model: AvailableModel = {
			provider,
			id,
			name: stringValue(raw.name) ?? `${provider}/${id}`,
			contextWindow: positiveNumber(raw.contextWindow),
			maxTokens: positiveNumber(raw.maxTokens),
			reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
			images: hasImageCapability ? images : undefined,
		};
		models.push(model);
	}
	return models;
}

/** Extract parent-session references emitted by either Pi implementation. */
export function getPiSessionParent(entry: unknown): string | undefined {
	const record = asRecord(entry);
	if (!record || record.type !== "session") return undefined;
	const header = asRecord(record.header);
	const candidates = [
		record.parentSession,
		record.branchedFrom,
		record.parent_session,
		header?.parentSession,
		header?.branchedFrom,
		header?.parent_session,
	];
	return candidates.map(stringValue).find((value): value is string => Boolean(value));
}
