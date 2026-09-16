import type { ProviderId } from "../../types";

/**
 * Mock public URLs.
 *
 * `.test` is reserved by RFC 6761 and can never resolve, so nothing here (and
 * no provider) is reachable even if a reviewer opens a URL. Hosts are shaped
 * like the real provider domains only so the UI reads naturally:
 *
 *   https://brightside-dental.vercel.example.test
 *   https://brightside-dental-v3.vercel.example.test
 */
export const MOCK_URL_DOMAIN = "example.test";

const SITE_SLUG = "brightside-dental";

/** Provider-specific host label; `null` means the plain business domain. */
const PROVIDER_HOST_LABEL: Record<ProviderId, string | null> = {
  vercel: "vercel",
  netlify: "netlify",
  "cloudflare-pages": "pages",
  "custom-vps": null,
  railway: "railway",
  "fly-io": "fly",
  render: "render",
};

/** The alias URL the provider keeps pointing at the newest live version. */
export function mockProjectUrl(providerId: ProviderId): string {
  const label = PROVIDER_HOST_LABEL[providerId];
  return label
    ? `https://${SITE_SLUG}.${label}.${MOCK_URL_DOMAIN}`
    : `https://${SITE_SLUG}.${MOCK_URL_DOMAIN}`;
}

/** Immutable per-version URL, so history rows stay distinguishable. */
export function mockDeploymentUrl(providerId: ProviderId, version: number): string {
  const label = PROVIDER_HOST_LABEL[providerId];
  const host = `${SITE_SLUG}-v${version}`;
  return label
    ? `https://${host}.${label}.${MOCK_URL_DOMAIN}`
    : `https://${host}.${MOCK_URL_DOMAIN}`;
}

export function isMockUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes(MOCK_URL_DOMAIN);
}
