import { privacy, terms, type LegalSection } from './pages/legal-content';

/**
 * The public pages as HTML a crawler can read without running the app.
 *
 * Google's OAuth verification checks that the homepage links to the Privacy
 * Policy and that the policy is available as HTML. The app renders both only
 * after its script runs, so the build also writes `privacy.html` and
 * `terms.html` (Cloudflare Pages serves them at `/privacy` and `/terms`) and
 * gives every copy a `<noscript>` body. A browser with scripts never shows it;
 * the app mounts into `#root` exactly as before.
 */

export type StaticPublicPage = { fileName: string; html: string };

const SUPPORT_EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/u;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const LEGAL_LINKS =
  '<nav aria-label="Legal"><a href="/">Soty</a> · <a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Use</a></nav>';

function legalBody(title: string, sections: readonly LegalSection[], supportEmail: string): string {
  const content = sections
    .map(section => {
      const id = section.id ? ` id="${escapeHtml(section.id)}"` : '';
      const paragraphs = section.paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('');
      return `<section${id}><h2>${escapeHtml(section.heading)}</h2>${paragraphs}</section>`;
    })
    .join('');
  return `<noscript><main><h1>${escapeHtml(title)} — Soty</h1>${content}<p>Contact: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>${LEGAL_LINKS}</main></noscript>`;
}

function withBody(indexHtml: string, noscript: string, title?: string): string {
  const root = '<div id="root"></div>';
  if (!indexHtml.includes(root))
    throw new Error('static-public-pages: #root not found in index.html');
  let html = indexHtml.replace(root, `${root}\n    ${noscript}`);
  if (title) html = html.replace(/<title>[^<]*<\/title>/u, `<title>${escapeHtml(title)}</title>`);
  return html;
}

export function staticPublicPages(indexHtml: string, supportEmail: string): StaticPublicPage[] {
  if (!SUPPORT_EMAIL_PATTERN.test(supportEmail)) {
    throw new Error('static-public-pages: the support email is not configured');
  }
  const homepage = `<noscript><main><h1>Soty</h1><p>Free local tools for media buyers, and spaces that keep your work in a Google Drive folder you pick, alone or with people you invite.</p>${LEGAL_LINKS}</main></noscript>`;
  return [
    { fileName: 'index.html', html: withBody(indexHtml, homepage) },
    {
      fileName: 'privacy.html',
      html: withBody(
        indexHtml,
        legalBody('Privacy Policy', privacy.en, supportEmail),
        'Privacy Policy — Soty'
      )
    },
    {
      fileName: 'terms.html',
      html: withBody(
        indexHtml,
        legalBody('Terms of Use', terms.en, supportEmail),
        'Terms of Use — Soty'
      )
    }
  ];
}
