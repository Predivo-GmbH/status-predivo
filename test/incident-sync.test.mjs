// The self-healing status page's rules and guard, offline. Run: node --test test/
// Every rule here is one Roger agreed to on 2026-10-01 (Playbook docs/PLAN-self-healing-status-page-2026-10-01.md).
import { test } from 'node:test'
import assert from 'node:assert'
import { decide } from '../scripts/lib/decide.mjs'
import { guard, TEMPLATES, SERVICES, MAX_CHARS } from '../scripts/lib/guard.mjs'

const T0 = Date.parse('2026-01-01T00:00:00Z')
const at = (min) => new Date(T0 + min * 60000).toISOString()
function walk(steps, slug = 'website', start = {}) {
  let state = start
  const log = []
  for (const [verdict, min] of steps) {
    const r = decide(state, { [slug]: verdict }, at(min))
    state = r.state
    if (r.actions.some((a) => a.type === 'open')) state[slug].incident.id = 'inc1'
    log.push(r.actions)
  }
  return { state, log }
}
const types = (actions) => actions.map((a) => a.type)

test('one failed check does nothing - no incident, no red, no email', () => {
  const { log } = walk([['up', 0], ['down', 5], ['up', 10]])
  assert.deepEqual(log.map(types), [[], [], []])
})

test('two failed checks in a row open ONE incident, turn the service red and email subscribers', () => {
  const { log } = walk([['down', 0], ['down', 5], ['down', 10], ['down', 15]])
  assert.deepEqual(log.map(types), [[], ['open'], [], []])
  const open = log[1][0]
  assert.equal(open.notify, true)
  assert.equal(open.component, 'major_outage')
})

test('slow (degraded) opens a "slow" incident with the degraded colour', () => {
  const { log } = walk([['degraded', 0], ['degraded', 5]])
  assert.equal(log[1][0].kind, 'degraded')
  assert.equal(log[1][0].component, 'degraded_performance')
})

test('60 minutes without any post during an outage brings one fixed "still working" line, no email', () => {
  const { log } = walk([['down', 0], ['down', 5], ['down', 60], ['down', 66], ['down', 70]])
  assert.deepEqual(log.map(types), [[], ['open'], [], ['still'], []])
  assert.equal(log[3][0].notify, false)
})

test('first good check: monitoring and green, no email; third good check: resolved, email', () => {
  const { log } = walk([['down', 0], ['down', 5], ['up', 10], ['up', 15], ['up', 20]])
  assert.deepEqual(log.map(types), [[], ['open'], ['monitoring'], [], ['resolve']])
  assert.equal(log[2][0].component, 'operational')
  assert.equal(log[2][0].notify, false)
  assert.equal(log[4][0].notify, true)
})

test('failing again while we watch goes back to investigating without a second email', () => {
  const { log } = walk([['down', 0], ['down', 5], ['up', 10], ['down', 15], ['down', 20]])
  assert.deepEqual(log.map(types), [[], ['open'], ['monitoring'], [], ['relapse']])
  assert.equal(log[4][0].notify, false)
})

test('a new failure within 60 minutes of closing reopens the same incident', () => {
  const first = walk([['down', 0], ['down', 5], ['up', 10], ['up', 15], ['up', 20]])
  const second = walk([['down', 40], ['down', 45]], 'website', first.state)
  assert.equal(second.log[1][0].type, 'reopen')
  assert.equal(second.log[1][0].id, 'inc1')
})

test('a failure more than 60 minutes after closing opens a new incident', () => {
  const first = walk([['down', 0], ['down', 5], ['up', 10], ['up', 15], ['up', 20]])
  const second = walk([['down', 120], ['down', 125]], 'website', first.state)
  assert.equal(second.log[1][0].type, 'open')
})

test('each service is judged on its own', () => {
  const r = decide({}, { website: 'down', 'client-portal': 'up' }, at(0))
  const r2 = decide(r.state, { website: 'down', 'client-portal': 'up' }, at(5))
  assert.deepEqual(r2.actions.map((a) => `${a.type}:${a.slug}`), ['open:website'])
})

test('an unknown verdict is an error, never silently "fine"', () => {
  assert.throws(() => decide({}, { website: 'maybe' }, at(0)))
})

// ---- the guard ---------------------------------------------------------------------------------------
test('every fixed text passes the guard, for every service, in the state it is posted in', () => {
  for (const slug of Object.keys(SERVICES)) {
    for (const kind of ['down', 'degraded']) assert.deepEqual(guard(TEMPLATES.investigating(slug, kind)).reasons, [], `${slug} investigating ${kind}`)
    assert.deepEqual(guard(TEMPLATES.still(slug)).reasons, [], `${slug} still`)
    assert.deepEqual(guard(TEMPLATES.healing(slug)).reasons, [], `${slug} healing`)
    assert.deepEqual(guard(TEMPLATES.monitoring(slug), { probeUp: true }).reasons, [], `${slug} monitoring`)
    assert.deepEqual(guard(TEMPLATES.resolved(slug), { probeUp: true }).reasons, [], `${slug} resolved`)
  }
})

const ok = { de: 'Die Website ist zurzeit nicht erreichbar. Wir untersuchen die Ursache.', en: 'The website is currently not reachable. We are investigating.' }
const refused = (text, ctx) => guard({ ...ok, ...text }, ctx)

test('the guard refuses a key, a token or a JWT', () => {
  assert.equal(refused({ en: 'The key sb_secret_abc123 was rotated and the website is not reachable.' }).ok, false)
  assert.equal(refused({ en: 'Token eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.x is not the website.' }).ok, false)
  assert.equal(refused({ de: 'Die Website ist nicht erreichbar: Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78.' }).ok, false)
})
test('the guard refuses an IP address', () => {
  assert.equal(refused({ en: 'The server 80.74.145.155 is not responding and we are on it.' }).ok, false)
})
test('the guard refuses our internal names', () => {
  for (const word of ['cockpit', 'BackOffice', 'staging', 'tertia', 'upptime', 'deploy.yml', 'contact.php', 'the board'])
    assert.equal(refused({ en: `The website is down because of ${word} and we are on it.` }).ok, false, word)
})
test('the guard refuses a supplier named as the cause', () => {
  assert.equal(refused({ de: 'Die Website ist wegen Metanet nicht erreichbar, wir sind dran.' }).ok, false)
  assert.equal(refused({ en: 'Cloudflare is causing the website outage and we are on it.' }).ok, false)
})
test('the guard refuses a promised time', () => {
  assert.equal(refused({ de: 'Die Website ist in 10 Minuten wieder da, wir sind dran.' }).ok, false)
  assert.equal(refused({ en: 'The website will be back within one hour, we are on it.' }).ok, false)
  assert.equal(refused({ de: 'Die Website ist bis 15:00 Uhr nicht erreichbar.' }).ok, false)
})
test('the guard refuses "fixed" while the check still fails, and allows it once it passes', () => {
  const fixed = { de: 'Die Störung ist behoben und die Website läuft wieder.', en: 'The incident is resolved and the website is working normally again.' }
  assert.equal(guard(fixed).ok, false)
  assert.equal(guard(fixed, { probeUp: true }).ok, true)
})
test('the guard refuses a missing language, the wrong language and an over-long text', () => {
  assert.equal(guard({ de: ok.de, en: '' }).ok, false)
  assert.equal(guard({ de: ok.en, en: ok.en }).ok, false, 'English text in the German slot')
  assert.equal(guard({ de: ok.de + ' Wir sind dran.'.repeat(60), en: ok.en }).reasons.some((r) => r.includes(String(MAX_CHARS))), true)
})
