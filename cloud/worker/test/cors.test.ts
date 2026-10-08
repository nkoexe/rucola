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

  it("allows preflight requests from local Expo web", async () => {
    const request = new Request("https://rucola.njco.dev/v1/pairing/bootstrap", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8081",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    const response = corsPreflight(request);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:8081");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("content-type");
  });

  it("allows the production website origin", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "https://rucola.njco.dev" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.get("access-control-allow-origin")).toBe("https://rucola.njco.dev");
  });

  it("allows IPv6 localhost for Expo web development", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "http://[::1]:8081" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.get("access-control-allow-origin")).toBe("http://[::1]:8081");
  });

  it("does not allow arbitrary origins", async () => {
    const request = new Request("https://rucola.njco.dev/health", {
      headers: { Origin: "https://evil.example" },
    });
    const response = withCors(request, new Response("ok"));
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});
