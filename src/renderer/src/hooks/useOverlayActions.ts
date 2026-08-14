import { useState, useCallback, useMemo } from "react";
import { desktopApi as api } from "../desktopApi";

interface ConfirmDialogConfig {
  title: string;
  message: string;
  onConfirm: () => void;
  danger?: boolean;
  confirmLabel?: string;
}

interface TrustRequest {
  requestId: string;
  cwd: string;
  projectName: string;
}

export function useOverlayActions() {
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogConfig | null>(null);
  const [trustRequest, setTrustRequest] = useState<TrustRequest | null>(null);

  const showConfirm = useCallback((config: ConfirmDialogConfig) => setConfirmDialog(config), []);
  const clearConfirm = useCallback(() => setConfirmDialog(null), []);

  const overlayProps = useMemo(() => ({
    confirm: confirmDialog ? {
      open: true as const,
      props: {
        title: confirmDialog.title,
        message: confirmDialog.message,
        onConfirm: confirmDialog.onConfirm,
        onCancel: () => setConfirmDialog(null),
        danger: confirmDialog.danger,
        confirmLabel: confirmDialog.confirmLabel,
      },
    } : undefined,
    trust: trustRequest ? {
      open: true as const,
      requestId: trustRequest.requestId,
      cwd: trustRequest.cwd,
      projectName: trustRequest.projectName,
      onChoose: (choice: "trust-remember" | "trust-session" | "deny") => {
        api.projects.respondTrustRequest(trustRequest.requestId, choice);
        setTrustRequest(null);
      },
    } : undefined,
  }), [confirmDialog, trustRequest]);

  return {
    confirmDialog,
    showConfirm,
    clearConfirm,
    trustRequest,
    setTrustRequest,
    overlayProps,
  };
}
