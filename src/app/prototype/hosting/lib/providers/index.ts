import type {
  ProviderAdapterRegistry,
  SimulationHarness,
} from "../../provider-contract";
import type { PrototypeDeploymentProvider, ProviderId } from "../../types";
import { createCloudflarePagesAdapter } from "./cloudflare-pages-adapter";
import { createCustomVpsAdapter } from "./custom-vps-adapter";
import { createNetlifyAdapter } from "./netlify-adapter";
import { createVercelAdapter } from "./vercel-adapter";

/**
 * Provider catalog + adapter registry.
 *
 * The catalog is what the picker renders (including providers that have no
 * adapter yet). The registry hands out one adapter instance per provider, so
 * switching providers in the UI swaps the whole data source without changing a
 * single component.
 */

export const PROTOTYPE_PROVIDERS: PrototypeDeploymentProvider[] = [
  {
    id: "vercel",
    name: "Vercel",
    description: "Zero-config hosting for generated Next.js sites.",
    availability: "available",
    requirement: "A project-scoped access token and a target team.",
    tag: "Recommended",
    cliHint: "vercel deploy --prod --yes",
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "Static hosting with redirect and form handling.",
    availability: "available",
    requirement: "A personal access token and a site ID.",
    tag: null,
    cliHint: "netlify deploy --prod --dir=out",
  },
  {
    id: "cloudflare-pages",
    name: "Cloudflare Pages",
    description: "Edge-hosted static output on a global CDN.",
    availability: "available",
    requirement: "An API token plus an account ID.",
    tag: null,
    cliHint: "wrangler pages deploy out",
  },
  {
    id: "custom-vps",
    name: "Custom / VPS",
    description: "Publish to infrastructure you already run.",
    availability: "available",
    requirement: "A deploy target you configure yourself.",
    tag: "Advanced",
    cliHint: "./scripts/publish.sh production",
  },
  {
    id: "railway",
    name: "Railway",
    description: "Containerised hosting with usage-based pricing.",
    availability: "coming_soon",
    requirement: "No adapter yet.",
    tag: null,
    cliHint: "railway up",
  },
  {
    id: "fly-io",
    name: "Fly.io",
    description: "Apps running close to the end user.",
    availability: "coming_soon",
    requirement: "No adapter yet.",
    tag: null,
    cliHint: "flyctl deploy",
  },
  {
    id: "render",
    name: "Render",
    description: "Static sites and services from one dashboard.",
    availability: "coming_soon",
    requirement: "No adapter yet.",
    tag: null,
    cliHint: "render deploys create",
  },
];

export function createPrototypeProviders(options: {
  harness: SimulationHarness;
}): ProviderAdapterRegistry {
  const adapters = [
    createVercelAdapter(options.harness),
    createNetlifyAdapter(options.harness),
    createCloudflarePagesAdapter(options.harness),
    createCustomVpsAdapter(options.harness),
  ];

  return {
    listProviders: () => PROTOTYPE_PROVIDERS,
    listAdapters: () => adapters,
    getAdapter: (providerId: ProviderId) =>
      adapters.find((adapter) => adapter.providerId === providerId) ?? null,
    availableProviderIds: () => adapters.map((adapter) => adapter.providerId),
  };
}
