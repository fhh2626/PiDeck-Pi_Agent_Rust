import {
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "./config";
import { writeDebugArtifact } from "./debug";
import { compactWithRecovery, resolveCompactionModel } from "./compaction";
import { EXTENSION_ID, type ExtensionConfig } from "./types";

function notifyWarning(ctx: ExtensionContext, message: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(`${EXTENSION_ID}: ${message}`, "warning");
	}
}

/**
 * The single compaction path for every model (provider-agnostic):
 *
 *   resolveCompactionModel()  ->  compactWithRecovery()
 *
 * compactWithRecovery() runs Pi's native compact() on the full preparation,
 * recovers context overflow in bounded segments, and applies the
 * retained-oversize pass. Returning undefined hands the compaction back to pi
 * (the "pi-default" outcome), which keeps its own streaming UI.
 */
async function handleSessionBeforeCompact(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	config: ExtensionConfig,
) {
	if (!config.enabled) {
		return undefined;
	}

	if (event.signal.aborted) {
		return { cancel: true };
	}

	writeDebugArtifact(
		"compaction-event",
		{
			event: "session_before_compact.enter",
			customInstructions: event.customInstructions,
			currentModel: ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined,
			preparation: {
				tokensBefore: event.preparation.tokensBefore,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				previousSummaryPresent: Boolean(event.preparation.previousSummary),
				messagesToSummarizeCount: event.preparation.messagesToSummarize.length,
				turnPrefixMessagesCount: event.preparation.turnPrefixMessages.length,
			},
		},
		config,
		ctx,
	);

	const resolution = resolveCompactionModel(ctx, config);

	if (resolution.warning) {
		notifyWarning(ctx, resolution.warning);
		writeDebugArtifact(
			"compaction-event",
			{
				event: "session_before_compact.model-resolution",
				warning: resolution.warning,
				modelSpec: resolution.modelSpec,
			},
			config,
			ctx,
		);
	}

	const outcome = await compactWithRecovery(event, ctx, config, resolution.model, {
		onEvent: (data) => writeDebugArtifact("compaction-event", data, config, ctx),
	});

	if (outcome.kind === "cancel") {
		return { cancel: true };
	}
	if (outcome.kind === "compaction") {
		return { compaction: outcome.compaction };
	}

	// pi-default: hand off to pi's own native compaction (keeps its streaming UI).
	return undefined;
}

export default function (pi: ExtensionAPI) {
	// Pi reloads the extension to apply config changes. Keep parsed config in this
	// extension instance so compaction never performs synchronous file I/O.
	const { config, source, warnings } = loadExtensionConfig();

	pi.on("session_start", (_event, ctx) => {
		if (!config.enabled) return;

		if (warnings.length > 0 && ctx.hasUI && config.debug) {
			ctx.ui.notify(`${EXTENSION_ID}: ${warnings[0]}`, "warning");
		}

		const artifactPath = writeDebugArtifact(
			"lifecycle",
			{
				event: "session_start",
				config,
				configSource: source,
				warnings,
			},
			config,
			ctx,
		);

		if (ctx.hasUI && (config.notifyOnLoad || config.debug)) {
			ctx.ui.notify(
				artifactPath
					? `${EXTENSION_ID} loaded • debug artifacts → ${artifactPath}`
					: `${EXTENSION_ID} loaded`,
				"info",
			);
		}
	});

	pi.on("session_before_compact", (event, ctx) => handleSessionBeforeCompact(event, ctx, config));
}
