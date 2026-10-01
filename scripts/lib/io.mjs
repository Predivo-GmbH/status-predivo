// The two outside things the self-healing status page talks to, shared by incident-sync.mjs (layer A)
// and post-update.mjs (layers B and C): the Statuspage API and the incident state on the
// incident-state branch (GitHub contents API, sha-checked so two runs never overwrite each other).
import fs from 'fs'

export const cfg = JSON.parse(fs.readFileSync('statuspage.json', 'utf8'))

export async function sp(method, path, body) {
  const r = await fetch(`https://api.statuspage.io/v1/pages/${cfg.page_id}${path}`, {
    method, headers: { Authorization: `OAuth ${process.env.STATUSPAGE_API_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  await new Promise((res) => setTimeout(res, 1100)) // Statuspage allows about one request per second
  if (!r.ok) throw new Error(`Statuspage ${method} ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.status === 204 ? null : r.json()
}

const REPO = process.env.GITHUB_REPOSITORY || 'Predivo-GmbH/status-predivo'
const BRANCH = 'incident-state'
const FILE = 'incidents-state.json'
async function gh(method, path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, j: r.status === 204 ? null : await r.json().catch(() => null) }
}

export async function loadState() {
  if (!process.env.GITHUB_TOKEN) return { state: {}, sha: null }
  const r = await gh('GET', `/contents/${FILE}?ref=${BRANCH}`)
  if (r.status === 404) {
    const branch = await gh('GET', `/branches/${BRANCH}`)
    if (branch.status === 404) {
      const head = await gh('GET', '/git/ref/heads/master')
      const made = await gh('POST', '/git/refs', { ref: `refs/heads/${BRANCH}`, sha: head.j.object.sha })
      if (made.status !== 201) throw new Error(`could not create branch ${BRANCH}: HTTP ${made.status}`)
    }
    return { state: {}, sha: null }
  }
  if (r.status !== 200) throw new Error(`could not read ${FILE}: HTTP ${r.status}`)
  return { state: JSON.parse(Buffer.from(r.j.content, 'base64').toString('utf8')), sha: r.j.sha }
}

export async function saveState(state, sha) {
  const body = { message: `incident state ${new Date().toISOString()}`, branch: BRANCH, content: Buffer.from(JSON.stringify(state, null, 2) + '\n').toString('base64') }
  if (sha) body.sha = sha
  const r = await gh('PUT', `/contents/${FILE}`, body)
  // 409/422 = another run wrote first; failing loudly is right - the next run starts from its state
  if (r.status !== 200 && r.status !== 201) throw new Error(`could not save ${FILE}: HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 160)}`)
}

/** Upptime's latest verdict per mapped service: { slug: 'up' | 'down' | 'degraded' } */
export function verdicts() {
  const summary = JSON.parse(fs.readFileSync('history/summary.json', 'utf8'))
  return Object.fromEntries(summary.filter((s) => cfg.components[s.slug]).map((s) => [s.slug, s.status]))
}
