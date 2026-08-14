import { useEffect, useRef } from "react";
import type { AvailableModel, SessionRuntimeTarget } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import type { ModelPending } from "../utils/modelPendingDisplay";
import {
  SessionCommandFailure,
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../utils/sessionCommands";

type RuntimeLike = {
  agentId?: string;
  runtimeGeneration?: number;
  status?: string;
  state?: { isStreaming?: boolean };
} | undefined;

/**
 * 生成结束后把「待生效」模型套到仍活着的 Agent。
 * 只写 catalog 不够：applyPreferences 只在启动/重启时跑，同一会话继续聊会仍用旧模型。
 */
export function usePendingModelApply(input: {
  sessionId: string;
  runtime: RuntimeLike;
  modelPending: ModelPending | undefined;
  applyRuntimeModelState: (state: { provider?: string; modelId?: string; modelName?: string }) => void;
  clearPending: () => void;
  offerRestart: (handle: SessionRuntimeTarget, model: AvailableModel) => void;
}) {
  const applyingRef = useRef(false);
  // 套模型若需重启，只弹一次；取消后也不要跟着 runtime 刷新再弹。
  const blockedRef = useRef(false);
  const callbacksRef = useRef(input);
  callbacksRef.current = input;

  useEffect(() => {
    blockedRef.current = false;
  }, [input.modelPending, input.sessionId]);

  const inFlight =
    input.runtime?.status === "running" || Boolean(input.runtime?.state?.isStreaming);
  const agentId = input.runtime?.agentId;
  const runtimeGeneration = input.runtime?.runtimeGeneration;

  useEffect(() => {
    const current = callbacksRef.current;
    if (!current.modelPending || applyingRef.current || blockedRef.current) return;
    if (inFlight) return;
    const handle = toSessionRuntimeTarget(current.sessionId, current.runtime);
    if (!handle) {
      current.clearPending();
      return;
    }
    const pending = current.modelPending;
    applyingRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const result = requireSessionCommand(
          await desktopApi.sessions.setRuntimeModel(
            handle,
            pending.to.provider,
            pending.to.modelId,
          ),
        );
        if (cancelled) return;
        current.applyRuntimeModelState(result.value);
        current.clearPending();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof SessionCommandFailure && error.needsRestart) {
          blockedRef.current = true;
          current.offerRestart(handle, {
            provider: pending.to.provider,
            id: pending.to.modelId,
            name: pending.to.modelName,
          });
          return;
        }
        if (
          error instanceof SessionCommandFailure &&
          (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED")
        ) {
          current.clearPending();
          return;
        }
        showNotice(error instanceof Error ? error.message : String(error), 4000);
      } finally {
        if (!cancelled) applyingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      applyingRef.current = false;
    };
  }, [input.modelPending, input.sessionId, inFlight, agentId, runtimeGeneration]);
}
