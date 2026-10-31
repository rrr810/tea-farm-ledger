export type SmsAdapter = {
  name: string;
  send: (opts: {
    to: string;
    body: string;
    farmId: string;
    type: string;
    /** Stable per-message reference for providers that support idempotent reconciliation. */
    trackingId?: string;
  }) => Promise<{ providerId?: string; segments: number; costEstimateCents?: number; status: "sent" | "queued" }>;
};
