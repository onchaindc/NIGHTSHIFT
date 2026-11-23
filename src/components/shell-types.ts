/** Shared shape of GET /api/status as consumed across the console. */
export interface StatusBody {
  ok: boolean;
  store: "ok" | "unavailable";
  services: { telegraph: boolean; telegram: boolean; chainRpc: boolean };
  defaultSpendLimitCents?: number;
}
