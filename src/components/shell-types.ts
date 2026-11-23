/** Shared shape of GET /api/status as consumed across the console. */
export interface StatusBody {
  ok: boolean;
  store: "ok" | "unavailable";
  services: { telegraph: boolean; telegram: boolean; chainRpc: boolean };
  defaultSpendLimitCents?: number;
  /** True when the caller (browser session) is authorized as the operator. */
  operatorSession?: boolean;
  persistence?: {
    connection?: "ok" | "unreachable" | "unconfigured";
    /** Database endpoint hostnames: operator-only, absent for anonymous reads. */
    hosts?: string[];
  };
}
