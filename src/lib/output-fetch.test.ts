// FIXTURE tests for guarded output download (fake fetch/DNS; no network).
import { describe, expect, it } from "vitest";
import { fetchOutput } from "./output-fetch";

const okDns = async () => {};
const body = (n: number) => new Response(new Uint8Array(n), { status: 200 });
const SS = "https://shotstack-api-v1-output.s3-ap-southeast-2.amazonaws.com/x/out.mp4";

describe("fetchOutput", () => {
  it("downloads allowed Shotstack output", async () => {
    const b = await fetchOutput(SS, "compose", { fetchImpl: async () => body(1000), dns: okDns });
    expect(b.byteLength).toBe(1000);
  });
  it("rejects non-provider host for compose route", async () => {
    await expect(fetchOutput("https://evil.example.com/x.mp4", "compose", { fetchImpl: async () => body(1), dns: okDns })).rejects.toThrow(/не разрешён/);
  });
  it("rejects private IP literal and http URLs", async () => {
    await expect(fetchOutput("https://10.0.0.5/x.mp4", "vizard", { dns: okDns })).rejects.toThrow(/Приватные/);
    await expect(fetchOutput("http://cdn.vizard.ai/x.mp4", "vizard", { dns: okDns })).rejects.toThrow(/https/);
  });
  it("rejects redirect to a private/local address", async () => {
    const f = async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/meta" } });
    await expect(fetchOutput("https://cdn.vizard.ai/x.mp4", "vizard", { fetchImpl: f as any, dns: okDns })).rejects.toThrow(/Приватные/);
  });
  it("rejects hosts whose DNS resolves privately", async () => {
    await expect(fetchOutput("https://cdn.vizard.ai/x.mp4", "vizard", { fetchImpl: async () => body(1), dns: async () => { throw new Error("Хост указывает на приватную сеть"); } })).rejects.toThrow(/приватную/);
  });
  it("rejects oversized output by header and by streamed bytes", async () => {
    const big = async () => new Response(new Uint8Array(10), { headers: { "content-length": "999999999" } });
    await expect(fetchOutput(SS, "compose", { fetchImpl: big as any, dns: okDns, maxBytes: 1000 })).rejects.toThrow(/слишком большой/);
    await expect(fetchOutput(SS, "compose", { fetchImpl: async () => new Response(new Uint8Array(5000)), dns: okDns, maxBytes: 1000 })).rejects.toThrow(/лимит/);
  });
});
