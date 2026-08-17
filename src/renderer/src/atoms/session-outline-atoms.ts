/**
 * 会话大纲 / 修改文件清单的派生 atom。
 *
 * 背景：这两份数据原本在 App 根组件里用 useMemo 计算，而 App 为了拿到消息数组
 * 直接订阅了 currentSessionMessagesAtom —— agent 流式输出时每追加一个 token，
 * App 整棵树（含设置弹窗等重组件）就重渲染一次。把计算下沉为派生 atom 后，
 * 只有真正消费它们的组件（OutlinePanel / useFileEditor 事件路径）才订阅，
 * App 根组件不再随消息流更新。
 *
 * 注意：派生 atom 每次消息链变化都会重算（流式输出时长度每次都在变，
 * 与原 useMemo 依赖 [messages.length] 的开销相当）；非流式的低频内容替换
 * （重启重生成、编辑消息）会多算一次，可接受。
 */
import { atom, type Getter } from "jotai";
import type { ChatMessage } from "../../../shared/types";
import type { SessionModifiedFile } from "../components/app/AppParts";
import {
  buildOutline,
  getToolChangedLineCount,
  getToolFilePath,
  getToolNewContent,
} from "../components/app/AppUtils";
import { currentSessionIdAtom, sessionMessagesCacheAtom } from "./session-atoms";

/** 当前聚焦会话的消息数组（只读派生，供大纲/文件清单计算）。 */
function currentSessionMessages(get: Getter): ChatMessage[] {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [] : [];
}

/**
 * 当前会话中 agent 修改过的文件（从 tool 消息 meta 中提取）。
 * 同一路径再次被修改时移到列表末尾，右侧修改清单按「最新修改」展示；
 * diff 展示使用工具参数（oldText/newText）计算变动区域。
 */
export const modifiedFilesAtom = atom((get) => {
  const byPath = new Map<string, SessionModifiedFile>();
  for (const msg of currentSessionMessages(get)) {
    if (msg.role !== "tool") continue;
    const toolName: string | undefined = msg.meta?.toolName as string | undefined;
    const args: unknown = msg.meta?.args;
    const status: string = String(msg.meta?.status ?? "done");
    // 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
    if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
    const filePath = getToolFilePath(args);
    if (!filePath) continue;
    const previous = byPath.get(filePath);
    // 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
    if (previous) byPath.delete(filePath);
    byPath.set(filePath, {
      path: filePath,
      toolName,
      status: status === "running" ? "running" : (previous?.status ?? status),
      changedLines:
        (previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
      originalContent: "",
      content: getToolNewContent(toolName, args) ?? previous?.content,
    });
  }
  return Array.from(byPath.values());
});

/** 当前聚焦会话的大纲条目（用户消息摘要），供右侧悬浮大纲导航列表展示。 */
export const outlineItemsAtom = atom((get) => {
  return buildOutline(currentSessionMessages(get));
});
