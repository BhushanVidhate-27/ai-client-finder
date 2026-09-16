import { EmailTransportError } from "@/lib/email-transport/service";

/**
 * Resend-specific, safe HTTPS helper.
 *
 * Every call is bounded by an AbortController timeout, always goes over HTTPS
 * to the Resend API endpoint, and never includes client-supplied URLs. Errors
 * are normalized into safe, secret-free EmailTransportError codes — response
 * bodies containing tokens, API keys or internal details are never surfaced.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

interface ResendErrorResponse {
  name?: string;
  message?: string;
}

function mapResendStatus(status: number, body: ResendErrorResponse | null): never {
  const name = body?.name ?? "";

  if (status === 401 || status === 403 || /unauthorized|forbidden/i.test(name)) {
    throw new EmailTransportError(
      `Resend rejected the request (HTTP ${status}).`,
      "PROVIDER_AUTH_FAILED",
    );
  }
  if (status === 429) {
    throw new EmailTransportError(
      `Resend rate limit exceeded (HTTP ${status}).`,
      "PROVIDER_RATE_LIMITED",
    );
  }
  if (status === 422) {
    throw new EmailTransportError(
      `Resend rejected the request (HTTP ${status}).`,
      "PROVIDER_REJECTED",
    );
  }

  throw new EmailTransportError(
    `Resend API error (HTTP ${status}).`,
    "PROVIDER_UNKNOWN_ERROR",
  );
}

export async function resendSafeFetchJson<T>(
  url: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    apiKey: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${init.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
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
      throw new EmailTransportError(
        `Resend API ${reason}.`,
        "PROVIDER_NETWORK_ERROR",
      );
    }

    if (!response.ok) {
      let body: ResendErrorResponse | null = null;
      try {
        body = (await response.json()) as ResendErrorResponse;
      } catch {
        // response body not JSON; proceed with null
      }
      mapResendStatus(response.status, body);
    }

    const text = await response.text();
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}
