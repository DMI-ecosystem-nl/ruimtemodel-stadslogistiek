import { NextResponse } from 'next/server';
import { getGitHubToken, hasGitHubCredentials } from '@/lib/github-auth';

/**
 * Turns feedback from the webapp into a GitHub issue.
 *
 * Env:
 * - GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
 *                          GitHub App with only "Issues: read and write", see `@/lib/github-auth`.
 * - GITHUB_FEEDBACK_TOKEN  fallback: fine-grained PAT with the same permission.
 * - GITHUB_FEEDBACK_REPO   optional, "owner/name"; defaults to the canonical repo.
 */
const DEFAULT_REPO = 'DMI-ecosystem-nl/ruimtemodel-stadslogistiek';

const FEEDBACK_TYPES = ['bug', 'suggestie', 'vraag'] as const;
type FeedbackType = (typeof FEEDBACK_TYPES)[number];

const LABEL_MAP: Record<FeedbackType, string> = {
  bug: 'bug',
  suggestie: 'enhancement',
  vraag: 'question',
};

const TYPE_TITLE: Record<FeedbackType, string> = {
  bug: 'Bug',
  suggestie: 'Suggestie',
  vraag: 'Vraag',
};

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
/** Best effort: per server instance, resets on restart. */
const recent = new Map<string, number[]>();

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

function rateLimited(ip: string) {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  recent.set(ip, hits);
  if (recent.size > 5000) recent.clear();
  return false;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Stop visitors from pinging GitHub users or teams with @mentions. */
function defuseMentions(text: string) {
  return text.replace(/@(?=[A-Za-z0-9_-])/g, '@​');
}

const EMAIL_RE = /^[^\s@`<>()[\]\\,;:"]+@[^\s@`<>()[\]\\,;:"]+\.[^\s@`<>()[\]\\,;:"]+$/;

export async function POST(request: Request) {
  if (!sameOrigin(request)) return fail('Niet toegestaan.', 403);

  if (!hasGitHubCredentials()) {
    console.error('[feedback] no GitHub credentials configured');
    return fail('Feedback is tijdelijk niet beschikbaar.', 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('Ongeldig verzoek.', 400);
  }

  // Honeypot filled in: pretend it worked, create nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return NextResponse.json({ success: true });
  }

  const { title, description, type } = body;
  const email = typeof body.email === 'string' ? body.email.trim() : '';

  if (email) {
    if (email.length > 256 || !EMAIL_RE.test(email)) {
      return fail('Ongeldig e-mailadres.', 400);
    }
    // The repository is public: only publish an address with explicit consent.
    if (body.emailConsent !== true) {
      return fail('Geef toestemming om je e-mailadres openbaar te tonen, of laat het veld leeg.', 400);
    }
  }

  if (typeof title !== 'string' || title.trim().length === 0) {
    return fail('Titel is verplicht.', 400);
  }
  if (title.length > 256) {
    return fail('Titel mag maximaal 256 tekens zijn.', 400);
  }
  if (typeof description !== 'string' || description.trim().length === 0) {
    return fail('Beschrijving is verplicht.', 400);
  }
  if (description.length > 5000) {
    return fail('Beschrijving mag maximaal 5000 tekens zijn.', 400);
  }
  if (!FEEDBACK_TYPES.includes(type as FeedbackType)) {
    return fail('Ongeldig feedbacktype.', 400);
  }
  const feedbackType = type as FeedbackType;

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) {
    return fail('Te veel berichten. Probeer het over een paar minuten opnieuw.', 429);
  }

  let token: string | null;
  try {
    token = await getGitHubToken();
  } catch (err) {
    console.error('[feedback] GitHub App authentication failed', err);
    return fail('Kon geen verbinding maken met GitHub.', 502);
  }
  if (!token) return fail('Feedback is tijdelijk niet beschikbaar.', 503);

  const issueTitle = defuseMentions(title.replace(/\s+/g, ' ').trim());
  const issueBody = [
    `**Type:** ${TYPE_TITLE[feedbackType]}`,
    // Backticks: no mention, no autolink. EMAIL_RE excludes backticks.
    ...(email ? [`**Contact:** \`${email}\``] : []),
    '',
    defuseMentions(description.trim()),
    '',
    '---',
    ...(email
      ? ['<sub>De indiener heeft toestemming gegeven om het e-mailadres openbaar in deze melding te tonen.</sub>', '']
      : []),
    '_Ingediend via de Ruimtemodel webapp_',
  ].join('\n');

  const repo = process.env.GITHUB_FEEDBACK_REPO || DEFAULT_REPO;
  const labels = [LABEL_MAP[feedbackType]];

  const create = (withLabels: boolean) =>
    fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ruimtemodel-stadslogistiek-feedback',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(withLabels ? { title: issueTitle, body: issueBody, labels } : { title: issueTitle, body: issueBody }),
      signal: AbortSignal.timeout(10_000),
    });

  try {
    let response = await create(true);
    // Labels can be rejected; the issue itself matters more.
    if (response.status === 422) response = await create(false);
    if (!response.ok) {
      console.error('[feedback] GitHub API', response.status, await response.text().catch(() => ''));
      return fail('Kon issue niet aanmaken op GitHub.', 502);
    }
    const issue = (await response.json()) as { number: number; html_url: string };
    return NextResponse.json({ success: true, issueUrl: issue.html_url, issueNumber: issue.number });
  } catch (err) {
    console.error('[feedback] GitHub request failed', err);
    return fail('Kon geen verbinding maken met GitHub.', 502);
  }
}
