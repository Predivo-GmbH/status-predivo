#!/usr/bin/env node
// THE ONE DOOR for every update that is not a fixed rule of layer A (Playbook
// docs/PLAN-self-healing-status-page-2026-10-01.md, layers B and C):
//   - healing  : one of our automatic repairs acted (fixed text, e.g. "we are redeploying the website")
//   - identified / update / monitoring : the AI's explanation while an incident is open
//   - review   : the AI's look back on a closed incident (what happened, why, the fix, the prevention)
// Every text goes through guard(); a refused text is NOT posted, the run fails with the reasons, and the
// fixed texts of layer A stay. No email is ever sent from here: subscribers are emailed only when an
// incident opens and closes (Roger, 2026-10-01).
//
// Run by the "Status update" workflow (workflow_dispatch or repository_dispatch), e.g. by the board worker:
//   gh workflow run "Status update" -R Predivo-GmbH/status-predivo -f slug=website -f stage=identified -f de="..." -f en="..."
// Env: SLUG, STAGE, TEXT_DE, TEXT_EN, STATUSPAGE_API_KEY, GITHUB_TOKEN.  --drill: end-to-end proof, see drill().
import { guard, compose, TEMPLATES } from './lib/guard.mjs'
import { cfg, sp, loadState, verdicts } from './lib/io.mjs'

export const STAGES = {
  healing: { status: 'identified', needs: 'open' },
  identified: { status: 'identified', needs: 'open' },
  update: { status: null, needs: 'open' },
  monitoring: { status: 'monitoring', needs: 'open', needsUp: true },
  review: { status: 'resolved', needs: 'resolved' },
}
const REVIEW_WINDOW_H = 48

/** Pure: which incident to post to, and whether this stage may post now. */
export function target(stage, slugState, verdict, now) {
  const rule = STAGES[stage]
  if (!rule) return { error: `unknown stage "${stage}" (allowed: ${Object.keys(STAGES).join(', ')})` }
  if (rule.needs === 'open') {
    if (!slugState?.incident?.id) return { error: `no open incident for this service - "${stage}" needs one` }
    if (rule.needsUp && verdict !== 'up') return { error: `"monitoring" needs the check to pass; it is "${verdict}"` }
    return { id: slugState.incident.id }
  }
  const last = slugState?.lastResolved
  if (!last?.id) return { error: 'no closed incident to review' }
  if ((new Date(now) - new Date(last.at)) / 3600000 > REVIEW_WINDOW_H) return { error: `the last incident closed more than ${REVIEW_WINDOW_H} h ago` }
  return { id: last.id }
}

/** Pure: the text for this stage, checked. */
export function textFor(stage, slug, de, en, verdict) {
  let t = stage === 'healing' && !de && !en ? TEMPLATES.healing(slug) : { de: de || '', en: en || '' }
  if (stage === 'review') t = { de: `Rückblick: ${t.de}`, en: `Review: ${t.en}` }
  const v = guard(t, { probeUp: verdict === 'up' || stage === 'review' })
  return v.ok ? { body: compose(t) } : { error: `the guard refused this text: ${v.reasons.join('; ')}` }
}

async function post(id, stage, body) {
  const patch = { body, deliver_notifications: false }
  if (STAGES[stage].status) patch.status = STAGES[stage].status
  await sp('PATCH', `/incidents/${id}`, { incident: patch })
}

async function main() {
  const slug = process.env.SLUG, stage = process.env.STAGE
  if (!cfg.components[slug]) throw new Error(`unknown service "${slug}" (known: ${Object.keys(cfg.components).join(', ')})`)
  const verdict = verdicts()[slug]
  const { state } = await loadState()
  const tgt = target(stage, state[slug], verdict, new Date().toISOString())
  if (tgt.error) { console.error(`::error::not posted: ${tgt.error}`); process.exit(1) }
  const txt = textFor(stage, slug, process.env.TEXT_DE, process.env.TEXT_EN, verdict)
  if (txt.error) { console.error(`::error::not posted: ${txt.error}`); process.exit(1) }
  await post(tgt.id, stage, txt.body)
  console.log(`posted ${stage} to incident ${tgt.id} (${slug}); emails: none`)
}

// The proof that the door works end to end: a labelled test incident (emails off), a healing note, an
// AI-style explanation, a planted bad text that MUST be refused, then resolved and deleted.
async function drill() {
  const inc = await sp('POST', '/incidents', { incident: {
    name: 'Systemtest – bitte ignorieren / System test – please ignore', status: 'investigating',
    body: compose(TEMPLATES.investigating('website', 'down')), deliver_notifications: false,
  } })
  const id = inc.id
  try {
    const s = { incident: { id } }
    for (const [stage, de, en] of [
      ['healing', '', ''],
      ['identified', 'Ein fehlerhaftes Update hat die Website unterbrochen. Wir stellen die vorherige Version wieder her.', 'A faulty update interrupted the website. We are restoring the previous version.'],
    ]) {
      const tgt = target(stage, s, 'down', new Date().toISOString())
      const txt = textFor(stage, 'website', de, en, 'down')
      if (tgt.error || txt.error) throw new Error(`drill ${stage}: ${tgt.error || txt.error}`)
      await post(tgt.id, stage, txt.body)
      console.log(`DRILL ${stage}: posted`)
    }
    const bad = textFor('update', 'website', 'Die Website ist wegen Metanet in 10 Minuten wieder da (80.74.145.155).', 'Fixed by redeploying deploy.yml on tertia.', 'down')
    if (!bad.error) throw new Error('drill: the planted bad text was NOT refused')
    console.log(`DRILL planted bad text refused: ${bad.error.slice(0, 160)}...`)
    await sp('PATCH', `/incidents/${id}`, { incident: { status: 'resolved', body: compose(TEMPLATES.resolved('website')), deliver_notifications: false } })
    const done = await sp('GET', `/incidents/${id}`)
    console.log(`DRILL incident ${id}: ${done.status}; updates: ${(done.incident_updates || []).map((u) => u.status).reverse().join(' > ')}`)
  } finally {
    await sp('DELETE', `/incidents/${id}`)
    console.log(`DRILL incident ${id} deleted`)
  }
}

if (process.argv[1]?.endsWith('post-update.mjs')) await (process.argv.includes('--drill') ? drill() : main())
