/**
 * AppShell 侧栏/抽屉像素回写策略。
 *
 * react-resizable-panels 的 expand() 在没有上次展开宽度时会落到 minSize。
 * 若把这个瞬时值写进 React 状态，会与「外部宽度 → panel.resize(saved)」互顶：
 * min ↔ saved，表现为抽屉打开后一直闪，点一下页面才停。
 */

export type PanelPixelCommitInput = {
  /** 面板当前实测像素（getSize().inPixels） */
  px: number;
  /** React / localStorage 里的保存宽度 */
  savedWidth: number;
  /** 面板 minSize（抽屉未钉住 180、钉住 220；侧栏 100） */
  minSize: number;
  /** 用户拖拽/键盘调分隔条为 true；窗口缩放、expand/resize effect 为 false */
  isUserInteraction: boolean;
};

/**
 * 折叠态像素：启动 defaultSize=0、或尚未 expand 完成。
 * 写成 0 会让宽度 effect 再 resize(0)，与 expand 形成 0↔min 震荡。
 */
export function isCollapsedPanelPixels(px: number): boolean {
  return px <= 1;
}

/**
 * 是否应把实测像素写回保存宽度。
 * 返回要写入的像素；null 表示忽略本轮，避免覆盖保存值或形成回路。
 */
export function shouldCommitPanelPixels(input: PanelPixelCommitInput): number | null {
  const px = Math.round(input.px);
  const saved = Math.round(input.savedWidth);
  if (isCollapsedPanelPixels(px)) return null;
  if (Math.abs(px - saved) <= 1) return null;
  // expand() 无历史宽度时落到 minSize。这是程序化瞬时值，不能盖掉默认/用户宽度。
  // 用户真把抽屉拖到下限时 isUserInteraction=true，允许写入。
  if (
    !input.isUserInteraction &&
    px <= input.minSize + 1 &&
    saved > input.minSize + 1
  ) {
    return null;
  }
  return px;
}
