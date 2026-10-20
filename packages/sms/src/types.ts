export type SmsAdapter = {
  name: string;
  send: (opts: { to: string; body: string; farmId: string; type: string }) => Promise<{ providerId?: string; segments: number; costEstimateCents?: number; status: "sent" | "queued" }>;
};
