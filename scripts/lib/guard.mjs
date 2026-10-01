// THE GUARD AND THE FIXED TEXTS of the self-healing status page.
//
// Every text that reaches status.predivo.ch - a fixed one from this file or one an AI wrote - passes
// guard() first. It is deliberately dumb and strict: a refused text never goes out, the fixed text
// stays, and the worst a customer can ever read is a plain sentence, never a wrong or leaking one.
// Plan: Playbook docs/PLAN-self-healing-status-page-2026-10-01.md section 3.

export const MAX_CHARS = 600

const SECRET_SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // a JWT
  /\b(sb_(publishable|secret)_|sk_(live|test)_|pk_(live|test)_|rk_(live|test)_|ghp_|gho_|ghs_|github_pat_|xox[bpa]-)/i,
  /[A-Za-z0-9+/_-]{32,}/, // any long token-like run
]
const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/
// names customers do not know and must not be shown: our tools, hosts, files and jobs
const INTERNAL = /\b(cockpit|backoffice|staging|tertia|sui-inter|upptime|workflow|runner|board|signal-intake|deploy job|cron)\b|\.(mjs|js|ts|yml|yaml|php|json|env)\b/i
// a supplier named as the cause needs evidence on the board row; the text alone cannot carry it
const SUPPLIERS = /\b(metanet|cloudflare|github|atlassian|statuspage|supabase|google|amazon|aws|hetzner|plesk|postmark|anthropic)\b/i
// promising a time we cannot keep is worse than saying nothing
const TIME_PROMISE = [
  /\b(in|within|innerhalb(?:\s+von)?|binnen)\s+(\d+|einer|einem|einigen|wenigen|one|a few|few)\s*(sek\w*|sec\w*|min\w*|stunde\w*|std\.?|hour\w*|h)\b/i,
  /\bbis\s+(um\s+)?\d{1,2}([:.]\d{2})?\s*uhr\b/i,
  /\b(by|until)\s+\d{1,2}([:.]\d{2})?\s*(am|pm|o'clock)?\b/i,
]
// saying it works again is only allowed once the check says so
const FIXED_CLAIM = /(behoben|wieder (normal|erreichbar|verfügbar|online)|läuft wieder|funktioniert wieder|resolved|fixed|working normally|reachable again|available again|back (up|online)|is working again)/i
const DE_WORDS = /\b(die|der|das|ist|wir|und|nicht|wieder|zurzeit)\b/i
const EN_WORDS = /\b(the|is|we|and|not|again|currently)\b/i

/** @returns {{ok: boolean, reasons: string[]}} */
export function guard({ de, en }, { probeUp = false } = {}) {
  const reasons = []
  for (const [lang, text, words] of [['de', de, DE_WORDS], ['en', en, EN_WORDS]]) {
    if (!text || !String(text).trim()) { reasons.push(`${lang}: missing`); continue }
    if (text.length > MAX_CHARS) reasons.push(`${lang}: ${text.length} characters, the limit is ${MAX_CHARS}`)
    if (!words.test(text)) reasons.push(`${lang}: does not read as ${lang === 'de' ? 'German' : 'English'}`)
    if (SECRET_SHAPES.some((r) => r.test(text))) reasons.push(`${lang}: contains something shaped like a key or token`)
    if (IP.test(text)) reasons.push(`${lang}: contains an IP address`)
    const internal = text.match(INTERNAL)
    if (internal) reasons.push(`${lang}: names something internal ("${internal[0]}")`)
    const supplier = text.match(SUPPLIERS)
    if (supplier) reasons.push(`${lang}: names a supplier ("${supplier[0]}") - needs evidence, not a public guess`)
    if (TIME_PROMISE.some((r) => r.test(text))) reasons.push(`${lang}: promises a time`)
    if (!probeUp && FIXED_CLAIM.test(text)) reasons.push(`${lang}: says it works again while the check still fails`)
  }
  return { ok: reasons.length === 0, reasons }
}

/** One Statuspage body holding both languages, German first. */
export const compose = ({ de, en }) => `${de.trim()}\n\n${en.trim()}`

// The service names as customers read them (German needs the article).
export const SERVICES = {
  website: { de: 'Die Website', deAcc: 'die Website', deShort: 'Website', en: 'the website', enShort: 'Website' },
  'client-portal': { de: 'Das Kundenportal', deAcc: 'das Kundenportal', deShort: 'Kundenportal', en: 'the client portal', enShort: 'Client portal' },
  'contact-form': { de: 'Das Kontaktformular', deAcc: 'das Kontaktformular', deShort: 'Kontaktformular', en: 'the contact form', enShort: 'Contact form' },
  'client-portal-signin': { de: 'Die Anmeldung zum Kundenportal', deAcc: 'die Anmeldung zum Kundenportal', deShort: 'Anmeldung Kundenportal', en: 'the client portal sign-in', enShort: 'Client portal sign-in' },
  email: { de: 'Unser E-Mail-Server', deAcc: 'unseren E-Mail-Server', deShort: 'E-Mail', en: 'our email server', enShort: 'Email' },
}
const svc = (slug) => SERVICES[slug] || { de: `Der Dienst ${slug}`, deAcc: `den Dienst ${slug}`, deShort: slug, en: `the ${slug} service`, enShort: slug }
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** The fixed texts. Each is tested against guard() in test/incident-sync.test.mjs. */
export const TEMPLATES = {
  name(slug, kind) {
    const s = svc(slug)
    return kind === 'degraded' ? `${s.deShort} langsam / ${s.enShort} slow` : `${s.deShort} nicht erreichbar / ${s.enShort} unavailable`
  },
  investigating(slug, kind) {
    const s = svc(slug)
    return kind === 'degraded'
      ? { de: `${s.de} reagiert zurzeit langsam. Wir sind informiert und untersuchen die Ursache.`, en: `${cap(s.en)} is currently responding slowly. We are aware and are investigating the cause.` }
      : { de: `${s.de} ist zurzeit nicht erreichbar. Wir sind informiert und untersuchen die Ursache.`, en: `${cap(s.en)} is currently not reachable. We are aware and are investigating the cause.` }
  },
  still(slug) {
    const s = svc(slug)
    return { de: `Wir arbeiten weiter an der Störung. ${s.de} ist noch nicht wieder wie gewohnt verfügbar. Wir melden uns, sobald wir mehr wissen.`, en: `We are still working on this. ${cap(s.en)} is not yet available as usual. We will post an update as soon as we know more.` }
  },
  // posted when one of our automatic repairs acts (layer B), e.g. a redeploy
  healing(slug) {
    const s = svc(slug)
    return { de: `Wir haben die Ursache eingegrenzt und stellen ${s.deAcc} neu bereit.`, en: `We have narrowed down the cause and are redeploying ${s.en}.` }
  },
  monitoring(slug) {
    const s = svc(slug)
    return { de: `${s.de} ist wieder erreichbar. Wir beobachten die Lage, bis alles stabil läuft.`, en: `${cap(s.en)} is reachable again. We are monitoring until everything is stable.` }
  },
  resolved(slug) {
    const s = svc(slug)
    return { de: `${s.de} läuft wieder normal. Die Störung ist behoben.`, en: `${cap(s.en)} is working normally again. This incident has been resolved.` }
  },
}
