import { MOCK_URL_DOMAIN } from "../lib/simulation/mock-urls";
import { Tag } from "./status-badge";

export interface MockUrlProps {
  url: string | null;
  /** Short marker shown next to the address. */
  mark?: boolean;
  className?: string;
}

/**
 * Renders a public URL with a "mock" marker.
 *
 * Every address in this prototype lives on `*.example.test`, which is reserved
 * and can never resolve. Marking it in the UI keeps anyone from reading a URL
 * here as a real deployment.
 */
export function MockUrl({ url, mark = true, className = "" }: MockUrlProps) {
  if (!url) {
    return <span className="text-gray-400">Not published yet</span>;
  }

  const isPlaceholder = url.includes(MOCK_URL_DOMAIN);

  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="break-all font-mono text-xs text-gray-900">{url}</span>
      {mark && isPlaceholder ? <Tag tone="amber">mock</Tag> : null}
    </span>
  );
}
