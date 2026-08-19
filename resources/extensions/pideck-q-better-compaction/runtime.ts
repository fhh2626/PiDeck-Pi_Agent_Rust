import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RESPONSES_COMPACT_CAPABLE_APIS } from "./types";

type ResponsesApi = (typeof RESPONSES_COMPACT_CAPABLE_APIS)[number];
type RuntimeModel = Model<Api>;

export type ResponsesSummarySupportOptions = {
	enabled?: boolean;
	/** Responses APIs that should use direct prompt-based summarization. */
	responsesCompactApis?: readonly string[];
};

export type ResponsesSummaryRuntime = {
	provider: string;
	api: ResponsesApi;
	model: string;
	baseUrl: string;
	currentModel: RuntimeModel;
	apiKey: string;
	headers?: Record<string, string>;
};

export type ResponsesSummaryEnvironmentResolution =
	| { ok: true; runtime: ResponsesSummaryRuntime }
	| {
		ok: false;
		reason: "disabled" | "missing-model" | "unsupported-api" | "missing-base-url" | "missing-api-key";
		provider?: string;
		api?: string;
		model?: string;
		baseUrl?: string;
	};

function normalizeConfiguredApis(values: readonly string[] | undefined): Set<string> {
	return new Set((values ?? RESPONSES_COMPACT_CAPABLE_APIS).map((value) => value.trim()).filter(Boolean));
}

export function normalizeBaseUrl(baseUrl: string | undefined | null): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	return normalized || undefined;
}

export function buildResponsesUrl(baseUrl: string, api: ResponsesApi): string {
	const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
	if (api === "openai-codex-responses") {
		if (normalized.endsWith("/codex/responses")) return normalized;
		if (normalized.endsWith("/codex")) return `${normalized}/responses`;
		return `${normalized}/codex/responses`;
	}
	return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

export function isSupportedApi(api: string): api is ResponsesApi {
	return (RESPONSES_COMPACT_CAPABLE_APIS as readonly string[]).includes(api);
}

async function resolveRequestAuth(
	ctx: ExtensionContext,
	model: RuntimeModel,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
	const registry = ctx.modelRegistry as {
		getApiKeyAndHeaders?: (currentModel: RuntimeModel) => Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	if (typeof registry.getApiKeyAndHeaders !== "function") return {};
	const auth = await registry.getApiKeyAndHeaders(model);
	return auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {};
}

export async function resolveResponsesSummaryEnvironment(
	ctx: ExtensionContext,
	options: ResponsesSummarySupportOptions = {},
): Promise<ResponsesSummaryEnvironmentResolution> {
	if (options.enabled === false) return { ok: false, reason: "disabled" };

	const currentModel = ctx.model;
	const descriptor = {
		provider: currentModel?.provider,
		api: currentModel?.api,
		model: currentModel?.id,
		baseUrl: normalizeBaseUrl(currentModel?.baseUrl),
	};
	if (!currentModel || !descriptor.provider || !descriptor.api || !descriptor.model) {
		return { ok: false, reason: "missing-model", ...descriptor };
	}
	if (!normalizeConfiguredApis(options.responsesCompactApis).has(descriptor.api) || !isSupportedApi(descriptor.api)) {
		return { ok: false, reason: "unsupported-api", ...descriptor };
	}
	if (!descriptor.baseUrl) return { ok: false, reason: "missing-base-url", ...descriptor };

	const { apiKey, headers } = await resolveRequestAuth(ctx, currentModel);
	if (!apiKey) return { ok: false, reason: "missing-api-key", ...descriptor };

	return {
		ok: true,
		runtime: {
			provider: descriptor.provider,
			api: descriptor.api,
			model: descriptor.model,
			baseUrl: descriptor.baseUrl,
			currentModel,
			apiKey,
			headers,
		},
	};
}
