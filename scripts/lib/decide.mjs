// THE RULES of the self-healing status page, as one pure function (no network, no clock of its own),
// so every case is tested offline. incident-sync.mjs feeds it the latest Upptime verdicts and the
// stored state, then carries out the actions it returns.
//
// Rules (Playbook docs/PLAN-self-healing-status-page-2026-10-01.md, section 3A; Roger 2026-10-01):
//   - a service counts as failing only after 2 failed checks in a row (one blip does nothing);
//   - then ONE incident opens (or the last one reopens if it closed less than 60 min ago), and
//     subscribers are emailed;
//   - while it fails and nobody has posted for 60 min, a fixed "still working on it" line goes up;
//   - the first good check moves the incident to "monitoring" and turns the service green;
//   - 3 good checks in a row resolve it, and subscribers are emailed again.
//   Emails go out on open and on close only (Roger, 2026-10-01: "the email question, yes").

export const OPEN_AFTER = 2
export const RESOLVE_AFTER = 3
export const REOPEN_WINDOW_MIN = 60
export const SILENCE_MIN = 60
const COMPONENT = { up: 'operational', degraded: 'degraded_performance', down: 'major_outage' }

const minutes = (a, b) => (new Date(a) - new Date(b)) / 60000

/**
 * @param {object} state      { [slug]: { down, up, component, incident: {id, status, kind, lastPostAt}|null, lastResolved: {id, at}|null } }
 * @param {object} verdicts   { [slug]: 'up' | 'down' | 'degraded' }   (Upptime, this run)
 * @param {string} now        ISO time of this run
 * @returns {{ state: object, actions: object[] }}
 */
export function decide(state, verdicts, now) {
  const next = structuredClone(state || {})
  const actions = []
  for (const [slug, verdict] of Object.entries(verdicts)) {
    if (!COMPONENT[verdict]) throw new Error(`unknown verdict "${verdict}" for ${slug}`)
    const s = next[slug] || (next[slug] = { down: 0, up: 0, component: 'operational', incident: null, lastResolved: null })
    const failing = verdict !== 'up'
    if (failing) { s.down += 1; s.up = 0 } else { s.up += 1; s.down = 0 }

    // what the service should show: red only after OPEN_AFTER failures, green on the first good check
    let wantComponent = s.component
    if (failing && s.down >= OPEN_AFTER) wantComponent = COMPONENT[verdict]
    if (!failing) wantComponent = 'operational'

    const inc = s.incident
    if (failing && s.down >= OPEN_AFTER) {
      if (!inc) {
        const recent = s.lastResolved && minutes(now, s.lastResolved.at) < REOPEN_WINDOW_MIN
        actions.push({ type: recent ? 'reopen' : 'open', slug, kind: verdict, id: recent ? s.lastResolved.id : undefined, component: wantComponent, notify: true })
        s.incident = { id: recent ? s.lastResolved.id : null, status: 'investigating', kind: verdict, lastPostAt: now }
        s.lastResolved = null
      } else if (inc.status === 'monitoring') {
        // it failed again while we were watching: back to investigating, no second email
        actions.push({ type: 'relapse', slug, kind: verdict, id: inc.id, component: wantComponent, notify: false })
        inc.status = 'investigating'; inc.lastPostAt = now
      } else if (minutes(now, inc.lastPostAt) >= SILENCE_MIN) {
        actions.push({ type: 'still', slug, id: inc.id, notify: false })
        inc.lastPostAt = now
      }
    }
    if (!failing && inc) {
      if (s.up >= RESOLVE_AFTER) {
        actions.push({ type: 'resolve', slug, id: inc.id, component: 'operational', notify: true })
        s.lastResolved = { id: inc.id, at: now }
        s.incident = null
      } else if (inc.status !== 'monitoring') {
        actions.push({ type: 'monitoring', slug, id: inc.id, component: 'operational', notify: false })
        inc.status = 'monitoring'; inc.lastPostAt = now
      }
    }
    // a colour change that no incident action carries (e.g. recovery after a single blip never opened one)
    if (wantComponent !== s.component && !actions.some((a) => a.slug === slug && a.component)) {
      actions.push({ type: 'component', slug, component: wantComponent })
    }
    s.component = wantComponent
  }
  return { state: next, actions }
}
