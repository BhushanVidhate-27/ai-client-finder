import type { Metadata } from "next";
import HostingPrototype from "./hosting-client";

export const metadata: Metadata = {
  title: "Hosting & Deployment prototype · AI Client Finder",
  description:
    "UI/UX prototype for deploying generated websites. Simulated only — no commands are executed and no provider API is contacted.",
};

/**
 * Isolated prototype route: `/prototype/hosting`.
 *
 * Intentionally unauthenticated and self-contained so it can be reviewed without
 * touching the app's sessions, APIs, or data. See README.md in this folder before
 * wiring anything real into it.
 */
export default function HostingPrototypePage() {
  return <HostingPrototype />;
}
