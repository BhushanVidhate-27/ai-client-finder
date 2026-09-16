import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import {
  assertSafeFetchUrl,
  isBlockedHostname,
  isBlockedIpLiteral,
  isSafeRenderHref,
  isSafeUrlScheme,
  UnsafeUrlError,
} from "@/lib/url-safety";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SSRF protection", () => {
  const BLOCKED = [
    "http://localhost/",
    "http://localhost:3000/",
    "http://127.0.0.1/",
    "http://127.0.0.1:8080/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://metadata.google.internal/",
    "http://metadata/",
    "http://host.docker.internal/",
    "http://intranet/",
    "http://foo.local/",
    "http://foo.internal/",
  ];

  for (const url of BLOCKED) {
    it(`blocks ${url}`, async () => {
      await expect(assertSafeFetchUrl(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    });
  }

  it("blocks a hostname whose DNS resolves to a private address", async () => {
    const lookup = vi
      .spyOn(dns.promises, "lookup")
      .mockResolvedValue({ address: "10.1.2.3", family: 4 });
    await expect(assertSafeFetchUrl("https://evil.example/")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(lookup).toHaveBeenCalled();
  });

  it("blocks a hostname whose DNS resolves to ipv4-mapped loopback", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({
      address: "::ffff:127.0.0.1",
      family: 6,
    });
    await expect(assertSafeFetchUrl("https://evil.example/")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("allows a safe public https URL", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    });
    await expect(assertSafeFetchUrl("https://example.com/")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) schemes entirely", async () => {
    await expect(assertSafeFetchUrl("ftp://example.com/file")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertSafeFetchUrl("javascript:alert(1)")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(assertSafeFetchUrl("file:///etc/passwd")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});

describe("url helpers", () => {
  it("classifies IP literals", () => {
    expect(isBlockedIpLiteral("127.0.0.1")).toBe(true);
    expect(isBlockedIpLiteral("10.0.0.5")).toBe(true);
    expect(isBlockedIpLiteral("169.254.169.254")).toBe(true);
    expect(isBlockedIpLiteral("::1")).toBe(true);
    expect(isBlockedIpLiteral("fe80::1")).toBe(true);
    expect(isBlockedIpLiteral("8.8.8.8")).toBe(false);
  });

  it("classifies hostnames", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("host.local")).toBe(true);
    expect(isBlockedHostname("host.internal")).toBe(true);
    expect(isBlockedHostname("host.localdomain")).toBe(true);
    expect(isBlockedHostname("example.com")).toBe(false);
  });

  it("isSafeUrlScheme only admits http/https", () => {
    expect(isSafeUrlScheme("https://example.com")).toBe(true);
    expect(isSafeUrlScheme("http://example.com")).toBe(true);
    expect(isSafeUrlScheme("javascript:alert(1)")).toBe(false);
    expect(isSafeUrlScheme("data:text/html,x")).toBe(false);
  });
});

describe("render href safety", () => {
  it("allows safe external schemes and fragments", () => {
    expect(isSafeRenderHref("https://example.com")).toBe(true);
    expect(isSafeRenderHref("http://example.com")).toBe(true);
    expect(isSafeRenderHref("mailto:hi@example.com")).toBe(true);
    expect(isSafeRenderHref("tel:+15551234567")).toBe(true);
    expect(isSafeRenderHref("#contact")).toBe(true);
    expect(isSafeRenderHref("/index.html")).toBe(true);
    expect(isSafeRenderHref("./about.html")).toBe(true);
    expect(isSafeRenderHref("../up.html")).toBe(true);
  });

  it("blocks executable schemes", () => {
    expect(isSafeRenderHref("javascript:alert(1)")).toBe(false);
    expect(isSafeRenderHref("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeRenderHref("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeRenderHref("JaVaScRiPt:alert(1)")).toBe(false);
  });
});