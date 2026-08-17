import { BrowserSurface } from "./BrowserSurface";
import { GitPanel } from "../app/GitPanel";
import { DrawerContent } from "../app/AppParts";
import { SessionTrajectoryPanel } from "../session/trajectory/SessionTrajectoryPanel";
import { LazyWrapper } from "../../hooks/useLazyComponent";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { t } from "../../i18n";

// ── port objects (typed loosely — type tightening is a follow-up task) ──

export interface DrawerGitPort {
  enableGitManagement: boolean;
  activeProjectId: string | undefined;
  gitDrawerDiff: any;
  gitDiffDisplayMode: string;
  openCommitFileDiff: any;
  openWorkspaceFileDiff: any;
  toggleGitDiffDisplayMode: () => void;
  closeGitDiff: () => void;
  gitApi: any;
  gitInfo: any;
  switchBranch: any;
  createBranch: any;
}

export interface DrawerChromePort {
  onOpenDrawer: (panel: WorkspaceDrawerPanel) => void;
  onCloseDrawer: () => void;
  onCollapseDrawer: () => void;
}

export interface DrawerBrowserPort {
  browserFullscreen: boolean;
  onCloseBrowser: () => void;
  onMinimizeBrowser: () => void;
  onEnterBrowserFullscreen: () => void;
}

export interface DrawerFilesPort {
  sessionsProject: any;
  sessionsProjectId: string | undefined;
  files: any[];
  sessions: any[];
  sessionSourceFilter: Record<string, Set<string> | null>;
  sessionHistoryLoading: boolean;
  expandedDirs: Set<string>;
  onToggleDirectory: (dir: string) => void;
  onCollapseAllDirectories: () => void;
  setFileMenu: any;
  refreshFiles: any;
  projects: any[];
  refreshProjectSessions: any;
  runOpenSidebarSession: any;
  isSameSessionPath: any;
  runCopySession: any;
  runExportHistorySession: any;
  runDeleteHistorySession: any;
  viewFilePath: any;
  openFilePath: any;
  /** 在中间栏编辑器打开（可编辑 tab）；Git 变更行内“打开”按钮使用 */
  openEditorTab: any;
  api: any;
  t: any;
  /** 当前项目根目录：文件面板空白处拖入/粘贴/右键菜单的落点 */
  projectRoot: string | undefined;
  /** 从 OS 拖入文件（复制到目标目录） */
  onDropFiles: (targetDir: string, files: FileList) => void;
  /** 粘贴剪贴板文件（Ctrl+V / 右键菜单） */
  onPasteFiles: (targetDir: string) => void;
  /** 文件树内部拖拽移动 */
  onMoveFiles: (sourcePaths: string[], targetDir: string) => void;
}

export interface DrawerSurfaceProps {
  drawer: WorkspaceDrawerPanel | null;
  drawerCollapsed: boolean;
  git: DrawerGitPort;
  chrome: DrawerChromePort;
  browser: DrawerBrowserPort;
  files: DrawerFilesPort;
}

export function DrawerSurface(props: DrawerSurfaceProps) {
  const { drawer, drawerCollapsed, git, chrome, browser, files } = props;

  return (
    <>
      {/* 各面板不再挂「标题 + ×」顶栏：关闭/切换改走会话 Tab 栏右侧活动图标。 */}
      {drawer === "trajectory" && !drawerCollapsed ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          <SessionTrajectoryPanel />
        </div>
      ) : drawer === "browser" && !drawerCollapsed ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          <BrowserSurface
            fullscreen={browser.browserFullscreen}
            onClose={browser.onCloseBrowser}
            onMinimize={browser.onMinimizeBrowser}
            onEnterFullscreen={browser.onEnterBrowserFullscreen}
          />
        </div>
      ) : git.enableGitManagement && drawer === "git" && !drawerCollapsed && git.activeProjectId ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="git-drawer-stack">
            <div className="git-drawer-source">
              <GitPanel
                projectId={git.activeProjectId}
                projectRoot={files.projects.find((project: any) => project.id === git.activeProjectId)?.path}
                commitLog={git.gitApi.commitLog}
                commitDetail={git.gitApi.commitDetail}
                onOpenCommitFileDiff={git.openCommitFileDiff}
                onOpenWorkspaceFileDiff={git.openWorkspaceFileDiff}
                onOpenFile={files.openEditorTab}
                branchCompare={git.gitApi.branchCompare}
                getStatus={git.gitApi.status}
                stageFiles={git.gitApi.stage}
                unstageFiles={git.gitApi.unstage}
                discardFile={git.gitApi.discard}
                commit={git.gitApi.commit}
                branches={git.gitInfo.branches}
                currentBranch={git.gitInfo.current}
                onSwitchBranch={git.switchBranch}
                onCreateBranch={git.createBranch}
                cherryPick={git.gitApi.cherryPick}
                revert={git.gitApi.revert}
                reset={git.gitApi.reset}
                dropCommit={git.gitApi.dropCommit}
                generateCommitMessage={git.gitApi.generateCommitMessage}
                gitInit={git.gitApi.init}
                push={git.gitApi.push}
                pull={git.gitApi.pull}
                fetch={git.gitApi.fetch}
                aheadBehind={git.gitApi.aheadBehind}
                deleteFiles={git.gitApi.deleteFiles}
              />
            </div>
          </div>
        </div>
      ) : drawer && drawer !== "browser" && drawer !== "git" && drawer !== "trajectory" ? (
        <LazyWrapper
          // 滚动层上移到这里：files/sessions 面板自身不再滚动（见 timeline.css
          // .files-panel/.sessions-panel 注释），占位与内容共用同一滚动容器，配合
          // scrollbar-gutter: stable 让内容宽度不随滚动条出现/消失跳变——
          // 否则切 tab 重挂时占位(无滚动条,320) → 内容(有滚动条,310) 瞬间收窄，
          // 且树高度跨阈值时滚动条反复出现/消失，形成“呼吸式”宽度摆动。
          className="drawer-content-frame overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          enabled={true}
          threshold={0}
          rootMargin="50px"
          placeholder={
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-secondary)",
              fontSize: "14px"
            }}>
              {t("drawer.lazyLoading")}
            </div>
          }
        >
          <DrawerContent
            panel={drawer}
            project={drawer === "sessions" ? files.sessionsProject : undefined}
            files={files.files}
            sessions={(files.sessionsProjectId && files.sessionSourceFilter[files.sessionsProjectId as string]) ? files.sessions.filter(
              (s: any) => !s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"),
            ).concat(files.sessions.filter((s: any) => s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"))) : files.sessions}
            sessionsLoading={files.sessionHistoryLoading}
            expandedDirs={files.expandedDirs}
            onToggleDirectory={files.onToggleDirectory}
            onCollapseAllDirectories={files.onCollapseAllDirectories}
            onClose={chrome.onCloseDrawer}
            onFileContextMenu={(node: any, x: number, y: number) => files.setFileMenu({ node, x, y })}
            onRefreshFiles={() => {
              files.refreshFiles(git.activeProjectId);
            }}
            onOpenFolder={() => {
              const p = files.projects.find((p: any) => p.id === git.activeProjectId);
              if (p) void files.api.files.open(p.path);
            }}
            projectRoot={files.projectRoot}
            onDropFiles={files.onDropFiles}
            onPasteFiles={files.onPasteFiles}
            onMoveFiles={files.onMoveFiles}
            onRefreshSessions={() => {
              const projectId = files.sessionsProjectId ?? git.activeProjectId;
              if (projectId) void files.refreshProjectSessions(projectId, true);
            }}
            onOpenSession={(session: any) =>
              void files.runOpenSidebarSession(
                files.sessionsProjectId ?? git.activeProjectId ?? "",
                session,
              )
            }
            onRenameSession={async (filePath: string, newName: string) => {
              const session = files.sessions.find((candidate: any) =>
                files.isSameSessionPath(
                  candidate.filePath,
                  filePath,
                  candidate.wsl ? "wsl" : "native",
                ),
              );
              if (!session) return;
              await files.api.sessions.updateRecord(session.id, { title: newName });
              const projectId = files.sessionsProjectId ?? git.activeProjectId;
              if (projectId) await files.refreshProjectSessions(projectId, true);
            }}
            onCopySession={(session: any) =>
              files.runCopySession(
                session.id,
                files.sessionsProjectId ?? git.activeProjectId,
              )
            }
            onExportSession={files.runExportHistorySession}
            onDeleteSession={files.runDeleteHistorySession}
            onViewFile={files.viewFilePath}
            onOpenFile={files.openFilePath}
          />
        </LazyWrapper>
      ) : null}
    </>
  );
}
