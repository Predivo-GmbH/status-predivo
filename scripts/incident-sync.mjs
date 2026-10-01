#!/usr/bin/env node
// THE ALWAYS-ON LAYER of the self-healing status page (layer A of the plan). Runs on GitHub after every
// Upptime check, with no AI and nothing on our own machines, so it keeps working when they do not.
//
// It is the ONLY writer to Statuspage: service colours and incidents. It replaced statuspage-sync.mjs,
// which turned a service red on the first failed check - the plan says one blip must do nothing.
//
// State (streaks, the open incident per service) lives in incidents-state.json on the branch
// "incident-state", written through the GitHub contents API with its sha, so two runs can never
// silently overwrite each other and Upptime's own commits on master are never touched.
//
//   node scripts/incident-sync.mjs            normal run (needs STATUSPAGE_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY)
//   node scripts/incident-sync.mjs --dry-run  decide and print, write nothing
//   node scripts/incident-sync.mjs --drill    the end-to-end proof: a clearly labelled test incident is opened,
//                                             moved through monitoring and resolved, with emails OFF, then deleted
import { decide } from './lib/decide.mjs'
import { guard, compose, TEMPLATES } from './lib/guard.mjs'
import { cfg, sp, loadState, saveState, verdicts as readVerdicts } from './lib/io.mjs'

const DRY = process.argv.includes('--dry-run')
const DRILL = process.argv.includes('--drill')
if (!process.env.STATUSPAGE_API_KEY && !DRY) { console.error('STATUSPAGE_API_KEY is not set'); process.exit(1) }

// ---- carrying out one action ---------------------------------------------------------------------------
function textFor(a) {
  const t = a.type === 'open' || a.type === 'reopen' || a.type === 'relapse' ? TEMPLATES.investigating(a.slug, a.kind)
    : a.type === 'still' ? TEMPLATES.still(a.slug)
      : a.type === 'monitoring' ? TEMPLATES.monitoring(a.slug)
        : a.type === 'resolve' ? TEMPLATES.resolved(a.slug) : null
  if (!t) return null
  const verdict = guard(t, { probeUp: a.type === 'monitoring' || a.type === 'resolve' })
  // the fixed texts are tested, so a refusal here is a code defect: stop instead of posting
  if (!verdict.ok) throw new Error(`guard refused the fixed ${a.type} text for ${a.slug}: ${verdict.reasons.join('; ')}`)
  return compose(t)
}
const STATUS = { open: 'investigating', reopen: 'investigating', relapse: 'investigating', still: null, monitoring: 'monitoring', resolve: 'resolved' }

async function apply(a, componentId, opts = {}) {
  const body = textFor(a)
  const components = a.component && componentId ? { [componentId]: a.component } : undefined
  const notify = DRILL ? false : !!a.notify
  if (DRY) { console.log('  would', a.type, a.slug, a.component || '', notify ? '(email)' : '', body ? `\n    ${body.replace(/\n/g, '\n    ')}` : ''); return a.id || 'dry-run-id' }
  if (a.type === 'component') { await sp('PATCH', `/components/${componentId}`, { component: { status: a.component } }); return null }
  if (a.type === 'open') {
    const inc = await sp('POST', '/incidents', { incident: {
      name: opts.name || TEMPLATES.name(a.slug, a.kind), status: 'investigating', body,
      impact_override: a.kind === 'degraded' ? 'minor' : 'major',
      component_ids: componentId ? [componentId] : [], components, deliver_notifications: notify,
    } })
    return inc.id
  }
  const patch = { body, deliver_notifications: notify }
  if (STATUS[a.type]) patch.status = STATUS[a.type]
  if (components) patch.components = components
  await sp('PATCH', `/incidents/${a.id}`, { incident: patch })
  return a.id
}

// ---- the drill: the whole path against the real API, labelled, emails off, deleted afterwards ------------
async function drill() {
  console.log('DRILL: one labelled test incident through open -> still -> monitoring -> resolve, emails off')
  const t0 = Date.parse('2026-01-01T00:00:00Z')
  const at = (m) => new Date(t0 + m * 60000).toISOString()
  const steps = [['down', 0], ['down', 5], ['down', 70], ['up', 75], ['up', 80], ['up', 85]]
  let state = {}, id = null
  try {
    for (const [v, m] of steps) {
      const r = decide(state, { website: v }, at(m))
      state = r.state
      for (const a of r.actions.filter((x) => x.type !== 'component')) {
        if (id) a.id = id
        const got = await apply(a, null, { name: 'Systemtest – bitte ignorieren / System test – please ignore' })
        if (a.type === 'open') { id = got; state.website.incident.id = id }
        console.log(`  ${v} @+${m}min -> ${a.type} ok`)
      }
    }
    const inc = await sp('GET', `/incidents/${id}`)
    const kinds = (inc.incident_updates || []).map((u) => u.status).reverse().join(' > ')
    console.log(`DRILL incident ${id}: final status ${inc.status}; updates: ${kinds}`)
    if (inc.status !== 'resolved') throw new Error('drill incident did not end resolved')
  } finally {
    if (id) { await sp('DELETE', `/incidents/${id}`); console.log(`DRILL incident ${id} deleted`) }
  }
}

// ---- the normal run ---------------------------------------------------------------------------------------
async function run() {
  const verdicts = readVerdicts()
  const { state, sha } = DRY ? { state: {}, sha: null } : await loadState()

  // reconcile with what a person (or the AI, layer C) did on Statuspage since the last run
  for (const [slug, s] of Object.entries(state)) {
    if (!s.incident?.id || DRY) continue
    const inc = await sp('GET', `/incidents/${s.incident.id}`).catch(() => null)
    if (!inc) { s.incident = null; continue }
    if (inc.status === 'resolved' || inc.status === 'postmortem') { s.lastResolved = { id: inc.id, at: inc.resolved_at || new Date().toISOString() }; s.incident = null; continue }
    s.incident.status = inc.status
    const latest = (inc.incident_updates || []).map((u) => u.created_at).sort().pop()
    if (latest && latest > s.incident.lastPostAt) s.incident.lastPostAt = latest
  }

  const now = new Date().toISOString()
  const { state: next, actions } = decide(state, verdicts, now)
  console.log(`verdicts: ${Object.entries(verdicts).map(([k, v]) => `${k}=${v}`).join(', ')} | actions: ${actions.map((a) => `${a.type}:${a.slug}`).join(', ') || 'none'}`)
  // Save what was done even when an action fails halfway: otherwise the next run would not know an
  // incident is already open and would open a second one.
  // decide() gives each service at most one action per run, so a failed action is undone by keeping
  // that service's previous state: the next run sees the same situation and tries again.
  let failure = null
  for (const a of actions) {
    try {
      const id = await apply(a, cfg.components[a.slug])
      if (a.type === 'open') next[a.slug].incident.id = id
    } catch (e) {
      failure = failure || e
      console.error(`::error::${a.type} ${a.slug} failed: ${e.message}`)
      next[a.slug] = state[a.slug] ? structuredClone(state[a.slug]) : undefined
      if (!next[a.slug]) delete next[a.slug]
    }
  }
  if (!DRY) await saveState(next, sha)
  if (failure) throw failure
}

await (DRILL ? drill() : run())
