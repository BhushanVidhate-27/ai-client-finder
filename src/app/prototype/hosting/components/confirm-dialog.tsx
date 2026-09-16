"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** Extra context lines, e.g. what stays untouched. */
  details?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Modal confirmation.
 *
 * Deliberately a full stop in the flow: destructive actions in this dashboard
 * (Stop, Disconnect, Redeploy over a live version) never fire on a single click.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  details,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    cancelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-gray-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hosting-confirm-title"
        aria-describedby="hosting-confirm-description"
        className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        <h2 id="hosting-confirm-title" className="text-sm font-semibold text-gray-900">
          {title}
        </h2>
        <p id="hosting-confirm-description" className="mt-2 text-xs leading-relaxed text-gray-600">
          {description}
        </p>

        {details ? <div className="mt-3">{details}</div> : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button ref={cancelRef} variant="secondary" size="lg" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            size="lg"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>

        <p className="mt-3 text-center text-[11px] text-gray-400 sm:text-left">
          Prototype only — confirming changes nothing outside this page.
        </p>
      </div>
    </div>
  );
}
