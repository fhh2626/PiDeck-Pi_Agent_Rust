import { useEffect, useRef, useState } from "react";
import type { ExternalEditor } from "../../../../shared/types";
import { t } from "../../i18n";

const EDITOR_LOGO_URLS: Record<string, string> = {
  vscode: new URL("../../assets/editors/vscode.png", import.meta.url).href,
  cursor: new URL("../../assets/editors/cursor.png", import.meta.url).href,
  zed: new URL("../../assets/editors/zed.png", import.meta.url).href,
  sublime: new URL("../../assets/editors/sublime.svg", import.meta.url).href,
  idea: new URL("../../assets/editors/idea.svg", import.meta.url).href,
  webstorm: new URL("../../assets/editors/webstorm.svg", import.meta.url).href,
  phpstorm: new URL("../../assets/editors/phpstorm.svg", import.meta.url).href,
  pycharm: new URL("../../assets/editors/pycharm.svg", import.meta.url).href,
};

export type ExternalEditorOverlayProps = {
  open: boolean;
  editors: ExternalEditor[];
  anchor: { x: number; y: number } | null;
  projectPath: string | null;
  onClose: () => void;
  onOpenProject: (editor: ExternalEditor, projectPath: string) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

/** The chooser is intentionally dumb; project identity and stale-response policy live in the hook. */
export function ExternalEditorOverlay(props: ExternalEditorOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!overlayRef.current?.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [props.onClose, props.open]);

  if (!props.open || !props.anchor) return null;
  const logoFor = (editor: ExternalEditor) => EDITOR_LOGO_URLS[editor.id];
  const choose = (editor: ExternalEditor) => {
    if (!props.projectPath || openingId) return;
    setOpeningId(editor.id);
    Promise.resolve(props.onOpenProject(editor, props.projectPath))
      .catch((error) => props.onError?.(error))
      .finally(() => setOpeningId(null));
  };

  return (
    <div
      ref={overlayRef}
      className="editors-popover"
      style={{ left: props.anchor.x, top: props.anchor.y }}
      role="menu"
      aria-label={t("app.openWithEditor")}
      onClick={(event) => event.stopPropagation()}
    >
      {props.editors.length === 0 ? (
        <div className="editors-popover-empty">{t("app.noExternalEditors")}</div>
      ) : (
        props.editors.map((editor) => {
          const logo = logoFor(editor);
          return (
            <button
              type="button"
              key={editor.id}
              className="editors-popover-item"
              disabled={Boolean(openingId)}
              onClick={() => choose(editor)}
              role="menuitem"
              title={t("app.openProjectInEditor")}
            >
              <span className={`editor-logo ${editor.id}`}>
                {logo ? <img src={logo} alt="" /> : editor.id.slice(0, 2).toUpperCase()}
              </span>
              <span>{editor.name}</span>
            </button>
          );
        })
      )}
    </div>
  );
}

export { EDITOR_LOGO_URLS };
