import type { Env } from "./types";

export type RateLimitDecision = "ALLOWED" | "LIMITED" | "UNAVAILABLE";

export async function checkPairingRateLimit(
  env: Env,
  key: string,
): Promise<RateLimitDecision> {
  try {
    const result = await env.PAIRING_BOOTSTRAP_LIMITER.limit({ key });
    return result.success ? "ALLOWED" : "LIMITED";
  } catch (error) {
    console.error("rucola pairing rate limiter unavailable", error);
    return "UNAVAILABLE";
  }
}
