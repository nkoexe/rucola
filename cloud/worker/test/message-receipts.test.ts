import { describe, expect, it } from "vitest";
import { messageCiphertextHash } from "../src/message-receipts";

describe("message ciphertext hashing", () => {
  it("hashes only the bytes covered by a Uint8Array view", async () => {
    const backing = new TextEncoder().encode("prefix-target-suffix");
    const start = new TextEncoder().encode("prefix-").byteLength;
    const length = new TextEncoder().encode("target").byteLength;
    const view = new Uint8Array(backing.buffer, start, length);

    const expectedDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("target"));
    const expected = Array.from(new Uint8Array(expectedDigest), (byte) => byte.toString(16).padStart(2, "0")).join("");

    await expect(messageCiphertextHash({
      messageId: "hash-view-test",
      senderSeq: 1,
      type: "TEXT",
      ciphertextBytes: view,
      encryptionVersion: 1,
      createdAt: Date.now(),
      mediaUploadId: null,
    })).resolves.toBe(expected);
  });
});
