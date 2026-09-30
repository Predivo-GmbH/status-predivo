// Pushes Upptime's latest verdict (history/summary.json) to the Atlassian Statuspage components.
// Statuspage does no monitoring of its own; Upptime is the prober, Statuspage is the public page.
// Writes only when a component's status differs, so an unchanged run costs one GET.
import fs from 'fs'

const key = process.env.STATUSPAGE_API_KEY
if (!key) { console.error('STATUSPAGE_API_KEY is not set'); process.exit(1) }
const cfg = JSON.parse(fs.readFileSync('statuspage.json', 'utf8'))
const summary = JSON.parse(fs.readFileSync('history/summary.json', 'utf8'))
const MAP = { up: 'operational', degraded: 'degraded_performance', down: 'major_outage' }

const api = async (method, path, body) => {
  const r = await fetch(`https://api.statuspage.io/v1/pages/${cfg.page_id}${path}`, {
    method,
    headers: { Authorization: `OAuth ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`${method} ${path} -> HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

const current = new Map((await api('GET', '/components')).map(c => [c.id, c]))
let changed = 0
for (const site of summary) {
  const id = cfg.components[site.slug]
  if (!id) { console.log(`skip ${site.slug}: no Statuspage component mapped`); continue }
  const want = MAP[site.status]
  if (!want) throw new Error(`unknown Upptime status "${site.status}" for ${site.slug}`)
  const have = current.get(id)?.status
  if (have === undefined) throw new Error(`component ${id} (${site.slug}) does not exist on the page`)
  if (have === want) { console.log(`${site.name}: ${have} (unchanged)`); continue }
  await api('PATCH', `/components/${id}`, { component: { status: want } })
  console.log(`${site.name}: ${have} -> ${want}`)
  changed++
  await new Promise(r => setTimeout(r, 1100)) // Statuspage allows about one request per second
}
console.log(`${changed} component(s) changed`)
