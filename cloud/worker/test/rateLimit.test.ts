import { describe, expect, it, vi } from "vitest";
import { checkPairingRateLimit } from "../src/rateLimit";
import type { Env } from "../src/types";

function envWithLimiter(limit: (input: { key: string }) => Promise<{ success: boolean }>): Env {
  return {
    DB: {} as D1Database,
    MEDIA_BUCKET: {} as R2Bucket,
    PAIRING_BOOTSTRAP_LIMITER: { limit } as RateLimit,
  };
}

describe("pairing rate limit guard", () => {
  it("reports an allowed request", async () => {
    const decision = await checkPairingRateLimit(
      envWithLimiter(async ({ key }) => {
        expect(key).toBe("pairing-bootstrap:test");
        return { success: true };
      }),
      "pairing-bootstrap:test",
    );
    expect(decision).toBe("ALLOWED");
  });

  it("reports a limited request", async () => {
    const decision = await checkPairingRateLimit(
      envWithLimiter(async () => ({ success: false })),
      "pairing-bootstrap:test",
    );
    expect(decision).toBe("LIMITED");
  });

  it("contains a rate-limit binding failure instead of throwing", async () => {
    const error = new Error("binding unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const decision = await checkPairingRateLimit(
        envWithLimiter(async () => {
          throw error;
        }),
        "pairing-bootstrap:test",
      );
      expect(decision).toBe("UNAVAILABLE");
      expect(consoleError).toHaveBeenCalledWith(
        "rucola pairing rate limiter unavailable",
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
