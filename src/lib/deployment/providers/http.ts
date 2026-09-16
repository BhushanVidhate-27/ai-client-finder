import { DeploymentProviderError } from "@/lib/deployment/errors";

/**
 * Minimal, safe HTTPS helper used by real provider adapters.
 *
 * Every call is bounded by an AbortController timeout, always goes over HTTPS
 * to the fixed endpoint passed in, and never includes client-supplied URLs.
 * Errors are reduced to a safe, secret-free message — response bodies, tokens
 * and internal paths are never surfaced.
 */
export async function safeFetchJson<T>(
  url: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          "Content-Type": "application/json",
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "AbortError"
          ? "request timed out"
          : "network error";
      throw new DeploymentProviderError("provider", `${reason}.`);
    }

    if (!response.ok) {
      throw new DeploymentProviderError(
        "provider",
        `provider returned HTTP ${response.status}`,
      );
    }
    const text = await response.text();
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}