// @credits-system — Insufficient credits dialog: shown when balance is too low for a generation
"use client";

import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Gift, X } from "lucide-react";

interface CreditInsufficientDialogProps {
  open: boolean;
  onClose: () => void;
  currentBalance: number;
  requiredAmount: number;
  plan: string;
  dailyClaimed: boolean;
  onClaimDaily?: () => Promise<void>;
}

export function CreditInsufficientDialog({
  open,
  onClose,
  currentBalance,
  requiredAmount,
  plan,
  dailyClaimed,
  onClaimDaily,
}: CreditInsufficientDialogProps) {
  const isFree = plan === "free";
  const canClaim = isFree && !dailyClaimed && !!onClaimDaily;
  const shortfall = Math.max(0, requiredAmount - currentBalance);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Overlay */}
          <motion.div
            className="fixed inset-0 z-[10000] bg-black/60"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Dialog */}
          <motion.div
            className="fixed left-1/2 top-1/2 z-[10001] w-[380px] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {/* Close button */}
            <button data-testid="credits-insufficient-close"
              type="button"
              onClick={onClose}
              className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Icon */}
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-6 w-6 text-destructive" />
            </div>

            {/* Heading */}
            <h3
              data-testid="credits-insufficient-title"
              className="mb-1 text-lg font-semibold text-foreground"
            >
              积分不足
            </h3>
            <p className="mb-4 text-sm text-muted-foreground/70">
              本次需要{" "}
              <span className="font-medium text-foreground">{requiredAmount}</span>{" "}
              积分，当前可用{" "}
              <span className="font-medium text-foreground">
                {currentBalance}
              </span>{" "}
              积分。
            </p>

            {/* Balance comparison */}
            <div className="mb-5 flex items-center justify-between rounded-lg bg-muted px-4 py-3">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">需要</p>
                <p
                  data-testid="credits-insufficient-required"
                  className="text-lg font-semibold tabular-nums text-destructive"
                >
                  {requiredAmount}
                </p>
              </div>
              <div className="text-muted-foreground">/</div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">可用</p>
                <p
                  data-testid="credits-insufficient-available"
                  className="text-lg font-semibold tabular-nums text-foreground"
                >
                  {currentBalance}
                </p>
              </div>
              <div className="text-muted-foreground">=</div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">还差</p>
                <p
                  data-testid="credits-insufficient-shortfall"
                  className="text-lg font-semibold tabular-nums text-muted-foreground"
                >
                  {shortfall}
                </p>
              </div>
            </div>

            {/* CTAs */}
            <div className="flex flex-col gap-2">
              {canClaim && (
                <button data-testid="credits-insufficient-claim"
                  type="button"
                  onClick={async () => {
                    await onClaimDaily();
                    onClose();
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-success px-4 py-2.5 text-sm font-medium text-success-foreground transition-colors hover:bg-success/90"
                >
                  <Gift className="h-4 w-4" />
                  领取今日赠送
                </button>
              )}
              <a data-testid="credits-insufficient-topup"
                href="/settings?tab=billing"
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                去充值
              </a>
              <button data-testid="credits-insufficient-cancel"
                type="button"
                onClick={onClose}
                className="w-full rounded-lg px-4 py-2 text-sm text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
              >
                取消
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
