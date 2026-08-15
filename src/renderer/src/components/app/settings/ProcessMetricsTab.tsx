import { Activity, CircleStop, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentProcessMetric, ProcessMetricsSnapshot } from "../../../../../shared/types";
import { formatMb } from "../../../../../shared/formatBytes";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui-shadcn/table";
import { showNotice } from "../../../utils/notice";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";

/**
 * 进程与内存监控面板（由 Pi 管理界面迁入设置，独立 tab）。
 * 只监控 pi agent 子进程：Electron 自身进程的内存不再展示（用户自行在系统
 * 任务管理器/活动监视器中查看）。
 * 仅手动刷新：点击「刷新」时经 IPC 拉取一次快照，不做轮询，避免 tasklist/ps
 * 系统调用对性能敏感场景（大量 agent 并发）造成不必要的开销。
 * 内存统一以 MB 展示（formatMb），便于多进程横向对比。
 */
export function ProcessMetricsTab() {
  const [snapshot, setSnapshot] = useState<ProcessMetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 待停止确认的 agent：非 null 时弹出 ConfirmDialog（shadcn AlertDialog）
  const [stoppingAgent, setStoppingAgent] = useState<AgentProcessMetric | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.piDesktop.system.getProcessMetrics();
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载时先采一次，避免空面板（用户仍需点刷新才有最新值）
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 执行停止：调 system:stop-agent → 成功提示 + 刷新快照让该行消失；
   * 失败提示保留 toast（确认交互已由 ConfirmDialog 承担，结果通知用 toast）。
   * 多平台说明：停止走 AgentManager 正常停止流程（ChildProcess.kill），
   * Windows/Linux/macOS 由 Node 统一处理，不直接调系统 kill。
   */
  const stopAgent = useCallback(async (agent: AgentProcessMetric) => {
    try {
      await window.piDesktop.system.stopAgent(agent.agentId);
      showNotice(t("config.process.stopped", { agent: agent.agentId }), 2000, "info");
      await refresh();
    } catch (error) {
      showNotice(
        t("config.process.stopFailed", { agent: agent.agentId }) + (error instanceof Error ? `：${error.message}` : ""),
        4000,
        "error",
      );
    }
  }, [refresh]);

  const agents = snapshot?.agents ?? [];
  const agentTotal = snapshot?.totalAgentBytes ?? 0;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCw className={`size-3.5${loading ? " animate-spin" : ""}`} aria-hidden="true" />
          {t("config.process.refresh")}
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg border border-border-subtle bg-bg-panel p-4 text-control text-text-tertiary">
          {t("config.process.loadFailed")}：{error}
        </div>
      ) : null}

      {snapshot ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-border-subtle bg-bg-panel p-3">
              <div className="text-micro text-muted-foreground">{t("config.process.agentCount")}</div>
              <div className="mt-1 text-base font-semibold text-foreground">{agents.length}</div>
            </div>
            <div className="rounded-lg border border-border-subtle bg-bg-panel p-3">
              <div className="text-micro text-muted-foreground">{t("config.process.agentTotal")}</div>
              <div className="mt-1 text-base font-semibold text-foreground">{formatMb(agentTotal)}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
            <div className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2">
              <Activity className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-medium text-foreground">{t("config.process.agentSection")}</span>
              <span className="ml-auto text-micro text-muted-foreground">
                {t("config.process.sampledAt")}：{new Date(snapshot.sampledAt).toLocaleTimeString()}
              </span>
            </div>
            {agents.length === 0 ? (
              <div className="px-3 py-4 text-center text-control text-text-tertiary">
                {t("config.process.empty")}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("config.process.column.agentId")}</TableHead>
                    <TableHead>{t("config.process.column.session")}</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>{t("config.process.column.memory")}</TableHead>
                    <TableHead className="text-center">{t("config.process.column.action")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => (
                    <TableRow key={agent.pid}>
                      <TableCell className="max-w-56 truncate font-medium" title={agent.agentId}>
                        {agent.agentId}
                      </TableCell>
                      {/* 会话列：展示关联会话标题（进程监控与打开的对话对应起来）；
                          无绑定（匿名/终端 agent）时显示占位符 */}
                      <TableCell
                        className="max-w-56 truncate text-text-secondary"
                        title={agent.sessionId}
                      >
                        {agent.sessionTitle ?? agent.sessionId ?? "-"}
                      </TableCell>
                      <TableCell className="font-mono text-text-secondary">{agent.pid}</TableCell>
                      <TableCell className="font-mono text-text-secondary">
                        {agent.memoryBytes == null ? "-" : formatMb(agent.memoryBytes)}
                      </TableCell>
                      {/* 操作列固定最右侧（表格惯例），列内按钮居中显示 */}
                      <TableCell className="text-center">
                        {/* 停止操作：红色带文字按钮，避免 icon-sm 太小难点 */}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          title={t("config.process.stop", { agent: agent.agentId })}
                          aria-label={t("config.process.stop", { agent: agent.agentId })}
                          onClick={() => setStoppingAgent(agent)}
                        >
                          <CircleStop className="size-4" aria-hidden="true" />
                          {t("config.process.stop")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      ) : (
        <div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
      )}

      {/* 停止确认：shadcn AlertDialog（ConfirmDialog 统一封装），danger 红底按钮。
          停止是危险操作，用模态确认而非 toast 双按钮；ESC/遮罩关闭即取消。 */}
      {stoppingAgent ? (
        <ConfirmDialog
          title={t("config.process.stop")}
          message={t("config.process.stopConfirm", { agent: stoppingAgent.agentId })}
          confirmLabel={t("config.process.stop")}
          danger
          onConfirm={() => {
            const agent = stoppingAgent;
            setStoppingAgent(null);
            void stopAgent(agent);
          }}
          onCancel={() => setStoppingAgent(null)}
        />
      ) : null}
    </div>
  );
}
