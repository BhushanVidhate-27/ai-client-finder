import type {
  WebsiteProject,
  ProjectPage,
  SectionKind,
} from "@/lib/website-project";
import { isSafeRenderHref } from "@/lib/url-safety";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Returns the href only when it uses a scheme we are willing to render
 * (http/https/mailto/tel, protocol-relative, or relative). Blocks javascript:
 * and other executable schemes before they reach an anchor in generated HTML.
 */
function safeExternalHref(url: string): string | null {
  const trimmed = url.trim();
  return isSafeRenderHref(trimmed) ? trimmed : null;
}

function sanitizeColor(color: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#334155";
}

export function renderStyles(project: WebsiteProject): string {
  const p = project.designDirection.palette;
  const typo = project.designDirection.typography;

  return `
:root {
  --color-primary: ${sanitizeColor(p.primary)};
  --color-accent: ${sanitizeColor(p.accent)};
  --color-bg: ${sanitizeColor(p.background)};
  --color-surface: ${sanitizeColor(p.surface)};
  --color-text: ${sanitizeColor(p.text)};
  --color-muted: ${sanitizeColor(p.muted)};
  --font-heading: ${escapeHtml(typo.headingFont)}, ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-body: ${escapeHtml(typo.bodyFont)}, ui-sans-serif, system-ui, -apple-system, sans-serif;
  --space-section: clamp(4rem, 8vw, 7rem);
  --radius-sm: 0.375rem;
  --radius-md: 0.75rem;
  --max-w: 1120px;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  font-family: var(--font-body);
  color: var(--color-text);
  background: var(--color-bg);
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
img { max-width: 100%; display: block; }
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.container {
  width: 100%;
  max-width: var(--max-w);
  margin: 0 auto;
  padding: 0 1.25rem;
}
.site-header {
  position: sticky;
  top: 0;
  z-index: 50;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--color-surface);
  transition: box-shadow 0.25s ease;
}
.site-header.is-scrolled { box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06); }
.header__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 0;
  gap: 1rem;
}
.header__brand {
  font-family: var(--font-heading);
  font-weight: 800;
  font-size: 1.125rem;
  letter-spacing: -0.01em;
  color: var(--color-text);
  white-space: nowrap;
}
.nav-toggle__checker { display: none; }
.nav-toggle__icon {
  display: none;
  width: 24px;
  height: 24px;
  stroke: currentColor;
  stroke-width: 2;
  fill: none;
  cursor: pointer;
}
.nav__list {
  display: flex;
  gap: 1.5rem;
  align-items: center;
}
.nav__link {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--color-muted);
  transition: color 0.2s;
}
.nav__link:hover, .nav__link--active { color: var(--color-text); }
@media (max-width: 760px) {
  .nav-toggle__icon { display: block; }
  .nav__list {
    display: none;
    width: 100%;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.75rem 0 1rem;
    gap: 0.875rem;
  }
  .nav-toggle__checker:checked ~ .nav__list { display: flex; }
  .header__inner { flex-wrap: wrap; }
}
.hero {
  padding: var(--space-section) 0;
  background: linear-gradient(145deg, var(--color-surface) 0%, var(--color-bg) 100%);
}
.hero__eyebrow {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-primary);
  margin-bottom: 0.75rem;
}
.hero__heading {
  font-size: clamp(2rem, 5vw, 3.25rem);
  margin-bottom: 0.75rem;
  letter-spacing: -0.03em;
  max-width: 740px;
}
.hero__subheading {
  font-size: 1.125rem;
  color: var(--color-muted);
  max-width: 640px;
  margin: 0 auto 1.75rem;
  line-height: 1.6;
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  border-radius: var(--radius-md);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 0.9375rem;
  border: none;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.25s, background 0.25s, color 0.25s;
}
.btn:active { transform: translateY(1px); }
.btn--primary {
  background: var(--color-primary);
  color: #fff;
}
.btn--primary:hover {
  background: color-mix(in srgb, var(--color-primary), #000 12%);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
}
.btn--outline {
  background: transparent;
  border: 1.5px solid var(--color-primary);
  color: var(--color-primary);
}
.btn--outline:hover { background: var(--color-surface); }
.section { padding: var(--space-section) 0; }
.section__eyebrow {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-primary);
  margin-bottom: 0.625rem;
}
.section__heading {
  font-size: clamp(1.5rem, 3vw, 2rem);
  margin-bottom: 0.75rem;
}
.section__intro {
  color: var(--color-muted);
  max-width: 640px;
  margin-bottom: 1.5rem;
  line-height: 1.6;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 1.25rem;
  margin-top: 0.5rem;
}
.card {
  background: var(--color-surface);
  border-radius: var(--radius-md);
  padding: 1.5rem;
  transition: transform 0.2s, box-shadow 0.25s;
}
.card:hover {
  transform: translateY(-3px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.07);
}
.card__title {
  font-size: 1.125rem;
  margin-bottom: 0.5rem;
}
.card__body {
  color: var(--color-muted);
  font-size: 0.9375rem;
  line-height: 1.6;
}
.feature-list {
  list-style: none;
  margin-top: 0.5rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 1rem;
}
.feature-list__item {
  background: var(--color-surface);
  padding: 1.25rem 1.5rem;
  border-radius: var(--radius-md);
}
.feature-list__item h4 { font-size: 1rem; margin-bottom: 0.25rem; }
.feature-list__item p { color: var(--color-muted); font-size: 0.9375rem; }
.cta-band {
  background: var(--color-primary);
  color: #fff;
  padding: var(--space-section) 0;
  text-align: center;
}
.cta-band h2 { color: #fff; }
.cta-band p { color: color-mix(in srgb, #fff, #000 25%); margin: 0 auto; max-width: 560px; }
.cta-band .btn--primary { background: #fff; color: var(--color-text); }
.cta-band .btn--primary:hover { background: var(--color-surface); }
.site-footer {
  border-top: 1px solid var(--color-surface);
  background: var(--color-bg);
  padding: 2.5rem 0 1.5rem;
  color: var(--color-muted);
  font-size: 0.875rem;
}
.footer__grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 1.5rem;
}
.footer__brand strong {
  display: block;
  color: var(--color-text);
  font-family: var(--font-heading);
  font-size: 1rem;
  margin-bottom: 0.25rem;
}
.footer__list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.footer__list a:hover { color: var(--color-text); }
.footer__bottom {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-surface);
}
.footer__bottom p { font-size: 0.8125rem; color: var(--color-muted); }
.contact-list {
  list-style: none;
  display: grid;
  gap: 0.75rem;
  max-width: 420px;
  text-align: left;
}
.contact-list__label {
  font-weight: 600;
  font-size: 0.8125rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-muted);
  margin-bottom: 0.125rem;
}
.contact-list a { color: var(--color-primary); font-weight: 500; }
.contact-list a:hover { text-decoration: underline; }
.reveal {
  opacity: 0;
  transform: translateY(16px);
  transition: opacity 0.7s ease, transform 0.7s ease;
}
.reveal.is-visible { opacity: 1; transform: none; }
@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
}
`.trim();
}

export function renderScript(): string {
  return `
(function() {
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function() {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  var io = new IntersectionObserver(function(entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        entries[i].target.classList.add("is-visible");
        io.unobserve(entries[i].target);
      }
    }
  }, { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach(function(el) { io.observe(el); });
})();
`.trim();
}

function renderNav(
  project: WebsiteProject,
  currentPath: string,
  resolveHref: (path: string) => string,
): string {
  const links = project.pages
    .map(
      (page) =>
        `<a class="nav__link${currentPath === page.path ? " nav__link--active" : ""}" href="${escapeHtml(resolveHref(page.path))}">${escapeHtml(page.navLabel)}</a>`,
    )
    .join("\n      ");

  return `
<header class="site-header">
  <div class="container header__inner">
    <a href="${escapeHtml(resolveHref(project.pages[0]?.path ?? "/"))}">${escapeHtml(project.businessName)}</a>
    <label class="nav-toggle" aria-label="Toggle navigation">
      <input type="checkbox" class="nav-toggle__checker">
      <svg class="nav-toggle__icon" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </label>
    <nav class="nav__list">
      ${links}
      <a class="btn btn--primary" href="${escapeHtml(resolveHref(project.primaryCta.targetPage))}">${escapeHtml(project.primaryCta.label)}</a>
    </nav>
  </div>
</header>`;
}

function renderHero(
  project: WebsiteProject,
  page: ProjectPage,
  resolveHref: (path: string) => string,
): string {
  const hero = page.hero;
  const ctaHref = resolveHref(project.primaryCta.targetPage);

  return `
<section class="hero">
  <div class="container" style="text-align:center;display:flex;flex-direction:column;align-items:center">
    ${hero.eyebrow ? `<p class="hero__eyebrow">${escapeHtml(hero.eyebrow)}</p>` : ""}
    <h1 class="hero__heading">${escapeHtml(hero.heading)}</h1>
    <p class="hero__subheading">${escapeHtml(hero.subheading)}</p>
    <div>
      <a class="btn btn--primary" href="${escapeHtml(ctaHref)}">${escapeHtml(project.primaryCta.label)}</a>
    </div>
  </div>
</section>`;
}

function renderSectionHeading(section: { heading: string; body: string }): string {
  if (!section.body) return "";
  return `<p class="section__intro">${escapeHtml(section.body)}</p>`;
}

function renderSection(section: { kind: SectionKind; heading: string; body: string; items?: Array<{ title: string; body: string }> }): string {
  const itemsHtml = section.items
    ?.map(
      (item) => `
      <article class="card">
        <h3 class="card__title">${escapeHtml(item.title)}</h3>
        <p class="card__body">${escapeHtml(item.body)}</p>
      </article>`,
    )
    .join("");

  let contentHtml: string;
  if (section.kind === "features" && section.items && section.items.length > 0) {
    contentHtml = `
      <ul class="feature-list">
${section.items.map((item) => `
        <li class="feature-list__item">
          <div>
            <h4>${escapeHtml(item.title)}</h4>
            <p>${escapeHtml(item.body)}</p>
          </div>
        </li>`).join("\n")}
      </ul>`;
  } else if (itemsHtml) {
    contentHtml = `
      <div class="card-grid">${itemsHtml}
      </div>`;
  } else {
    contentHtml = renderSectionHeading(section);
  }

  return `
    <section class="section${section.kind === "cta" ? " cta-band" : ""}" id="${escapeHtml(section.kind)}">
      <div class="container">
        <h2 class="section__heading">${escapeHtml(section.heading)}</h2>
        ${contentHtml}
      </div>
    </section>`;
}

function renderContact(project: WebsiteProject, resolveHref: (path: string) => string): string {
  const c = project.contact;
  const ctaHref = resolveHref(project.primaryCta.targetPage);

  if (!c.email && !c.phone && !c.address) {
    return `
    <section class="section cta-band" id="contact">
      <div class="container">
        <h2 class="section__heading">${escapeHtml(project.primaryCta.label)}</h2>
        <p style="margin-bottom:1.5rem">${escapeHtml(project.primaryCta.subtext)}</p>
        <a class="btn btn--primary" href="${escapeHtml(ctaHref)}">${escapeHtml(project.primaryCta.label)}</a>
      </div>
    </section>`;
  }

  const items: string[] = [];
  if (c.email) {
    items.push(`<li><p class="contact-list__label">Email</p><a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></li>`);
  }
  if (c.phone) {
    items.push(`<li><p class="contact-list__label">Phone</p><a href="tel:${escapeHtml(c.phone)}">${escapeHtml(c.phone)}</a></li>`);
  }
  if (c.address) {
    const mapsHref = c.mapsUrl ? safeExternalHref(c.mapsUrl) : null;
    items.push(
      mapsHref
        ? `<li><p class="contact-list__label">Location</p><a href="${escapeHtml(mapsHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.address)}</a></li>`
        : `<li><p class="contact-list__label">Location</p>${escapeHtml(c.address)}</li>`,
    );
  }

  const ctaTarget = c.email ? `mailto:${c.email}` : ctaHref;

  return `
    <section class="section" id="contact">
      <div class="container">
        <h2 class="section__heading">Get in touch</h2>
        <ul class="contact-list">
          ${items.join("\n          ")}
        </ul>
        <div style="margin-top:1.5rem">
          <a class="btn btn--primary" href="${escapeHtml(ctaTarget)}">${escapeHtml(project.primaryCta.label)}</a>
        </div>
      </div>
    </section>`;
}

function renderFooter(project: WebsiteProject, resolveHref: (path: string) => string): string {
  const year = new Date().getFullYear();
  const links = project.pages
    .map(
      (p) =>
        `<a href="${escapeHtml(resolveHref(p.path))}">${escapeHtml(p.navLabel)}</a>`,
    )
    .join("\n        ");

  return `
<footer class="site-footer">
  <div class="container footer__grid">
    <div class="footer__brand">
      <strong>${escapeHtml(project.businessName)}</strong>
      <p style="margin-top:0.25rem">${escapeHtml(project.footerNote || "")}</p>
    </div>
    <nav class="footer__list">
      ${links}
    </nav>
  </div>
  <div class="footer__bottom">
    <div class="container"><p>&copy; ${year} ${escapeHtml(project.businessName)}. All rights reserved.</p></div>
  </div>
</footer>`;
}

export function renderPageDocument(
  project: WebsiteProject,
  pagePath: string,
  opts: { resolveHref: (path: string) => string; inlineCss: boolean },
): string {
  const page = project.pages.find((p) => p.path === pagePath) ?? project.pages[0];
  if (!page) throw new Error("No pages in project.");

  const cssFile = project.files.find((f) => f.path === "styles.css");
  const jsFile = project.files.find((f) => f.path === "script.js");
  const css = cssFile?.content ?? "";
  const js = jsFile?.content ?? "";

  const cssRef = opts.inlineCss
    ? `<style>${css}</style>`
    : `<link rel="stylesheet" href="/styles.css">`;
  const scriptRef = opts.inlineCss
    ? `<script>${js}</script>`
    : `<script defer src="/script.js"></script>`;

  const navHtml = renderNav(project, page.path, opts.resolveHref);
  const heroHtml = renderHero(project, page, opts.resolveHref);
  const sectionsHtml = page.sections.map(renderSection).join("\n");
  const contactHtml = page.hasContactSection
    ? renderContact(project, opts.resolveHref)
    : "";
  const footerHtml = renderFooter(project, opts.resolveHref);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)}</title>
  <meta name="description" content="${escapeHtml(page.description)}" />
  ${cssRef}
</head>
<body>
  ${navHtml}
  <main>
    ${heroHtml}
    ${sectionsHtml}
    ${contactHtml}
  </main>
  ${footerHtml}
  ${scriptRef}
</body>
</html>`;
}