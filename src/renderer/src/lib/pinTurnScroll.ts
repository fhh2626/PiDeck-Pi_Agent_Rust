/**
 * 时间线尾部工具：给「发送当下的新增消息」计算入场动画的 fresh id 集合。
 * 历史上这里还承担发送置顶（pin-to-top）清屏动画，2026 年用户反馈其与
 * 流式跟随有冲突、偶发页面抖动，已整体移除（提交时记录原因）。
 */

export type PinTurnMessage = {
  id: string;
  role: string;
};

/** 尾部新增消息 id（入场动画用）。历史首帧不闪；只有发送当下才给当前尾一条入场。 */
export function resolveFreshTailIds(
  messages: readonly PinTurnMessage[],
  previousTail: string | undefined,
  nextTail: string,
  pendingRequestId?: string,
): string[] {
  if (!previousTail) return pendingRequestId ? [nextTail] : [];
  if (nextTail === previousTail) return [];
  const baselineIndex = messages.findIndex((message) => message.id === previousTail);
  return baselineIndex < 0
    ? [nextTail]
    : messages.slice(baselineIndex + 1).map((message) => message.id);
}
