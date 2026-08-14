/**
 * 会话排版档位 → CSS 变量 的纯函数映射。
 *
 * 设计：设置页只暴露少量离散档位，不暴露像素/数值微调；
 * CSS 只消费 token（通过 App.tsx 注入的 --chat-* 变量），不理解设置枚举。
 * 所有档位到 CSS 值的映射集中在本文件，方便单测与后续加档。
 *
 * 默认"default"档必须与 styles/foundation.css 的 :root 基线值一致，
 * 避免旧用户升级后外观漂移（出厂观感即 default）。
 */

export type ChatTypographyDensity = "compact" | "default" | "relaxed";
export type ChatBodyLineHeightMode = "compact" | "default" | "relaxed" | "loose";

export interface ChatTypographySelectors {
  /** 会话正文字号档位（兼容传入 AppSettings 时只取需要的字段） */
  chatBodyLineHeight: ChatBodyLineHeightMode;
  chatBlockGap: ChatTypographyDensity;
  chatListDensity: ChatTypographyDensity;
  chatCodeDensity: ChatTypographyDensity;
}

export type ChatTypographyVars = Record<string, string>;

const BODY_LINE_HEIGHT: Record<ChatBodyLineHeightMode, string> = {
  compact: "1.2",
  default: "1.35",
  relaxed: "1.5",
  loose: "1.65",
};

const BLOCK_GAP: Record<ChatTypographyDensity, string> = {
  compact: "4px",
  default: "6px",
  relaxed: "10px",
};

const LIST_TOP: Record<ChatTypographyDensity, string> = {
  compact: "2px",
  default: "4px",
  relaxed: "6px",
};

const LIST_BOTTOM: Record<ChatTypographyDensity, string> = {
  compact: "4px",
  default: "6px",
  relaxed: "10px",
};

const LIST_ITEM: Record<ChatTypographyDensity, string> = {
  compact: "1px",
  default: "3px",
  relaxed: "6px",
};

const CODE_LINE_HEIGHT: Record<ChatTypographyDensity, string> = {
  compact: "1.45",
  default: "1.6",
  relaxed: "1.75",
};

const CODE_BLOCK_GAP: Record<ChatTypographyDensity, string> = {
  compact: "0.6rem",
  default: "0.85rem",
  relaxed: "1.1rem",
};

const TABLE_CELL_PADDING_Y: Record<ChatTypographyDensity, string> = {
  compact: "0.3rem",
  default: "0.45rem",
  relaxed: "0.6rem",
};

function isDensity(value: unknown): value is ChatTypographyDensity {
  return (
    value === "compact" ||
    value === "default" ||
    value === "relaxed"
  );
}

function isLineHeightMode(value: unknown): value is ChatBodyLineHeightMode {
  return (
    value === "compact" ||
    value === "default" ||
    value === "relaxed" ||
    value === "loose"
  );
}

/**
 * 解析设置档位 → CSS 变量表。
 * 非法/缺失值一律回退 "default"，保证旧 settings.json 与脏数据安全。
 */
export function resolveChatTypographyVars(
  settings: Partial<ChatTypographySelectors> | undefined,
): ChatTypographyVars {
  const bodyLine =
    settings && isLineHeightMode(settings.chatBodyLineHeight)
      ? settings.chatBodyLineHeight
      : "default";
  const blockGap =
    settings && isDensity(settings.chatBlockGap) ? settings.chatBlockGap : "default";
  const listDensity =
    settings && isDensity(settings.chatListDensity) ? settings.chatListDensity : "default";
  const codeDensity =
    settings && isDensity(settings.chatCodeDensity) ? settings.chatCodeDensity : "default";

  return {
    "--chat-body-line-height": BODY_LINE_HEIGHT[bodyLine],
    "--chat-block-gap": BLOCK_GAP[blockGap],
    "--chat-list-block-gap-top": LIST_TOP[listDensity],
    "--chat-list-block-gap-bottom": LIST_BOTTOM[listDensity],
    "--chat-list-item-gap": LIST_ITEM[listDensity],
    "--chat-code-line-height": CODE_LINE_HEIGHT[codeDensity],
    "--chat-code-block-gap": CODE_BLOCK_GAP[codeDensity],
    "--chat-table-cell-padding-y": TABLE_CELL_PADDING_Y[codeDensity],
  };
}

/** 语义化导出：测试与 App 注入共用同一真源。 */
export const CHAT_TYPOGRAPHY_VAR_NAMES = [
  "--chat-body-line-height",
  "--chat-block-gap",
  "--chat-list-block-gap-top",
  "--chat-list-block-gap-bottom",
  "--chat-list-item-gap",
  "--chat-code-line-height",
  "--chat-code-block-gap",
  "--chat-table-cell-padding-y",
] as const;
