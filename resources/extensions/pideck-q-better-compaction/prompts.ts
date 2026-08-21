/**
 * The portable handoff summary prompt used when the extension produces a
 * summary itself (overflow recovery segments, retained-oversize reduction).
 * Mirrors Codex's open-source local compaction prompt.
 */
export const CODEX_PORTABLE_SUMMARY_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.
`;
