import { describe, expect, it } from "vitest";
import { corsPreflight, withCors } from "../src/cors";

describe("web CORS", () => {
  it("allows local Expo web development origins", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "http://localhost:8081" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("allows preflight requests for the trusted production origin", async () => {
    const request = new Request("https://rucola.njco.dev/v1/pairing/session", {
      method: "OPTIONS",
      headers: { Origin: "https://rucola.njco.dev" },
    });
    const response = corsPreflight(request);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://rucola.njco.dev");
  });

  it("does not allow arbitrary origins", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "https://evil.example" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});


  it("allows IPv6 localhost for Expo web development", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "http://[::1]:8081" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.get("access-control-allow-origin")).toBe("http://[::1]:8081");
  });
