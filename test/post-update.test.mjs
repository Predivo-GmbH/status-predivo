// The one door for AI-written and repair updates (layers B and C), offline. Run: node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert'
import { target, textFor, requestsFor } from '../scripts/post-update.mjs'

const NOW = '2026-01-02T12:00:00.000Z'
const open = { incident: { id: 'inc1', status: 'investigating' } }
const closed = (hoursAgo) => ({ incident: null, lastResolved: { id: 'inc0', at: new Date(Date.parse(NOW) - hoursAgo * 3600000).toISOString() } })

test('while an incident is open, healing / identified / update go to it', () => {
  for (const stage of ['healing', 'identified', 'update']) assert.deepEqual(target(stage, open, 'down', NOW), { id: 'inc1' })
})
test('nothing is posted when no incident is open - an explanation needs an outage', () => {
  assert.match(target('identified', { incident: null }, 'up', NOW).error, /no open incident/)
  assert.match(target('healing', undefined, 'down', NOW).error, /no open incident/)
})
test('"monitoring" only once the check passes', () => {
  assert.match(target('monitoring', open, 'down', NOW).error, /needs the check to pass/)
  assert.deepEqual(target('monitoring', open, 'up', NOW), { id: 'inc1' })
})
test('the review goes to the incident that closed in the last 48 hours, never to an older one', () => {
  assert.deepEqual(target('review', closed(5), 'up', NOW), { id: 'inc0' })
  assert.match(target('review', closed(49), 'up', NOW).error, /more than 48/)
  assert.match(target('review', { incident: null }, 'up', NOW).error, /no closed incident/)
})
test('an unknown stage is refused', () => {
  assert.match(target('resolved', open, 'up', NOW).error, /unknown stage/)
})
test('a repair note without text uses the fixed healing text', () => {
  const t = textFor('healing', 'website', '', '', 'down')
  assert.ok(t.body.includes('neu bereit') && t.body.includes('redeploying the website'), t.body)
})
test('a sound AI text passes; the review is labelled as one', () => {
  assert.ok(textFor('identified', 'website', 'Ein fehlerhaftes Update hat die Website unterbrochen. Wir stellen die vorherige Version wieder her.', 'A faulty update interrupted the website. We are restoring the previous version.', 'down').body)
  const r = textFor('review', 'website', 'Ein fehlerhaftes Update war die Ursache. Es ist behoben, und neue Versionen werden jetzt vorher automatisch geprüft.', 'A faulty update was the cause. It is fixed, and new versions are now checked automatically before release.', 'up')
  assert.ok(r.body.startsWith('Rückblick: ') && r.body.includes('Review: '), r.body)
})
test('a review is published as the postmortem of the closed incident, never as an update (Statuspage refuses those, HTTP 422)', () => {
  const r = requestsFor('review', 'inc0', 'Rückblick: x\n\nReview: y')
  assert.deepEqual(r.map(([m, p]) => `${m} ${p}`), ['PUT /incidents/inc0/postmortem', 'PUT /incidents/inc0/postmortem/publish'])
  assert.equal(r[0][2].postmortem.body_draft, 'Rückblick: x\n\nReview: y')
  assert.equal(r[1][2].postmortem.notify_subscribers, false, 'no email from this door')
  assert.ok(!r.some(([m]) => m === 'PATCH'), 'a resolved incident is never patched')
})
test('an update on an open incident stays a PATCH with its status and no email', () => {
  const [[m, p, b]] = requestsFor('identified', 'inc1', 'text')
  assert.equal(`${m} ${p}`, 'PATCH /incidents/inc1')
  assert.deepEqual(b, { incident: { body: 'text', deliver_notifications: false, status: 'identified' } })
  const [[, , u]] = requestsFor('update', 'inc1', 'text')
  assert.equal(u.incident.status, undefined, 'a plain update keeps the current status')
})
test('a bad AI text is refused and never posted', () => {
  const bad = textFor('update', 'website', 'Die Website ist wegen Metanet in 10 Minuten wieder da.', 'Fixed by redeploying deploy.yml.', 'down')
  assert.ok(bad.error && /refused/.test(bad.error))
  assert.equal(bad.body, undefined)
})
