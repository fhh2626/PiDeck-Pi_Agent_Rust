import { atom } from "jotai";
import type { ComposerAgentMode, ImageContent } from "../../../shared/types";
import type { ModelPending } from "../utils/modelPendingDisplay";
import type { ThinkingLevelPending } from "../utils/thinkingDisplay";
import { currentSessionIdAtom } from "./session-atoms";

export type SessionComposerMode = ComposerAgentMode;
export type { ModelPending };

export type SessionSendState = {
  status: "idle" | "activating" | "sending" | "error" | "unknown";
  requestId?: string;
  error?: string;
  /** Snapshot kept visible when the transport result cannot prove delivery. */
  unknownSnapshot?: {
    message: string;
    images?: ImageContent[];
  };
};

export const sessionDraftByIdAtom = atom<Record<string, string>>({});
export const sessionAttachmentsByIdAtom = atom<Record<string, ImageContent[]>>({});
export const sessionComposerModeByIdAtom = atom<Record<string, SessionComposerMode>>({});
export const sessionSendStateByIdAtom = atom<Record<string, SessionSendState>>({});

/**
 * 流式生成中切换思考强度产生的「待生效」指示（issue #146，xhigh->max）。
 * 只在生成进行中设置；流式结束（没有进行中的生成）时由 ComposerArea 清除。
 */
export const thinkingLevelPendingByIdAtom = atom<
	Record<string, ThinkingLevelPending | undefined>
>({});

/**
 * 生成进行中切换模型：pi 不支持运行中 set_model，只写入会话记录；
 * 本轮结束后再套到 Agent。新加、不在启动快照里的模型不走这里，走重启确认。
 */
export const modelPendingByIdAtom = atom<Record<string, ModelPending | undefined>>({});

export const currentSessionDraftAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId ? (get(sessionDraftByIdAtom)[sessionId] ?? "") : "";
  },
  (get, set, value: string | ((current: string) => string)) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionDraftAtom, { sessionId, value });
  },
);

export const currentSessionAttachmentsAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId ? (get(sessionAttachmentsByIdAtom)[sessionId] ?? []) : [];
  },
  (get, set, value: ImageContent[] | ((current: ImageContent[]) => ImageContent[])) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionAttachmentsAtom, { sessionId, value });
  },
);

export const currentSessionComposerModeAtom = atom(
  (get) => {
    const sessionId = get(currentSessionIdAtom);
    return sessionId
      ? (get(sessionComposerModeByIdAtom)[sessionId] ?? "normal")
      : "normal";
  },
  (get, set, mode: SessionComposerMode) => {
    const sessionId = get(currentSessionIdAtom);
    if (!sessionId) return;
    set(setSessionComposerModeAtom, { sessionId, mode });
  },
);

export const currentSessionSendStateAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId
    ? (get(sessionSendStateByIdAtom)[sessionId] ?? { status: "idle" as const })
    : { status: "idle" as const };
});

export const setSessionDraftAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    value: string | ((current: string) => string);
  }) => {
    const drafts = get(sessionDraftByIdAtom);
    const current = drafts[input.sessionId] ?? "";
    const nextValue = typeof input.value === "function"
      ? input.value(current)
      : input.value;
    const next = { ...drafts };
    if (nextValue) next[input.sessionId] = nextValue;
    else delete next[input.sessionId];
    set(sessionDraftByIdAtom, next);
  },
);

export const setSessionAttachmentsAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]);
  }) => {
    const attachments = get(sessionAttachmentsByIdAtom);
    const current = attachments[input.sessionId] ?? [];
    const nextValue = typeof input.value === "function"
      ? input.value(current)
      : input.value;
    const next = { ...attachments };
    if (nextValue.length) next[input.sessionId] = nextValue;
    else delete next[input.sessionId];
    set(sessionAttachmentsByIdAtom, next);
  },
);

export const setSessionComposerModeAtom = atom(
  null,
  (get, set, input: { sessionId: string; mode: SessionComposerMode }) => {
    const modes = { ...get(sessionComposerModeByIdAtom) };
    if (input.mode === "normal") delete modes[input.sessionId];
    else modes[input.sessionId] = input.mode;
    set(sessionComposerModeByIdAtom, modes);
  },
);

export const setSessionSendStateAtom = atom(
  null,
  (get, set, input: { sessionId: string; state: SessionSendState }) => {
    const states = { ...get(sessionSendStateByIdAtom) };
    if (input.state.status === "idle") delete states[input.sessionId];
    else states[input.sessionId] = input.state;
    set(sessionSendStateByIdAtom, states);
  },
);

export const clearSessionComposerSnapshotAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    draft: string;
    attachments: ImageContent[];
  }) => {
    const currentDraft = get(sessionDraftByIdAtom)[input.sessionId] ?? "";
    if (currentDraft === input.draft) {
      set(setSessionDraftAtom, { sessionId: input.sessionId, value: "" });
    }
    const currentAttachments = get(sessionAttachmentsByIdAtom)[input.sessionId] ?? [];
    if (
      currentAttachments.length === input.attachments.length &&
      currentAttachments.every((attachment, index) => attachment === input.attachments[index])
    ) {
      set(setSessionAttachmentsAtom, { sessionId: input.sessionId, value: [] });
    }
  },
);

export const removeSessionComposerStateAtom = atom(null, (get, set, sessionId: string) => {
  const drafts = { ...get(sessionDraftByIdAtom) };
  delete drafts[sessionId];
  set(sessionDraftByIdAtom, drafts);
  const attachments = { ...get(sessionAttachmentsByIdAtom) };
  delete attachments[sessionId];
  set(sessionAttachmentsByIdAtom, attachments);
  const modes = { ...get(sessionComposerModeByIdAtom) };
  delete modes[sessionId];
  set(sessionComposerModeByIdAtom, modes);
  const sendStates = { ...get(sessionSendStateByIdAtom) };
  delete sendStates[sessionId];
  set(sessionSendStateByIdAtom, sendStates);
  const thinkingPending = { ...get(thinkingLevelPendingByIdAtom) };
  delete thinkingPending[sessionId];
  set(thinkingLevelPendingByIdAtom, thinkingPending);
  const modelPending = { ...get(modelPendingByIdAtom) };
  delete modelPending[sessionId];
  set(modelPendingByIdAtom, modelPending);
});
