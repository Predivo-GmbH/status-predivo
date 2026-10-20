#!/usr/bin/env node
// Sets the short description of one Statuspage component - the hover text next to a service on
// https://predivo.statuspage.io (status.predivo.ch shows its own "?" texts and falls back to this one).
// Run by the "Component description" workflow, so the API key never leaves the Actions environment:
//   gh workflow run "Component description" -R Predivo-GmbH/status-predivo -f slug=email -f description="Our email server"
// The text is public: no email address on a website (Roger, 2026-10-18), no key, no IP address.
// Env: SLUG, DESCRIPTION, STATUSPAGE_API_KEY.
import { SECRET_SHAPES, IP } from './lib/guard.mjs'
import { cfg, sp } from './lib/io.mjs'

export const MAX_DESCRIPTION = 200
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i

/** Pure: the reasons a description may not go out (empty = it may). */
export function refuse(text) {
  const t = String(text ?? '').trim()
  if (!t) return ['missing']
  const reasons = []
  if (t.length > MAX_DESCRIPTION) reasons.push(`${t.length} characters, the limit is ${MAX_DESCRIPTION}`)
  if (EMAIL.test(t)) reasons.push('contains an email address')
  if (SECRET_SHAPES.some((r) => r.test(t))) reasons.push('contains something shaped like a key or token')
  if (IP.test(t)) reasons.push('contains an IP address')
  return reasons
}

async function main() {
  const slug = process.env.SLUG
  const id = cfg.components[slug]
  if (!id) throw new Error(`unknown service "${slug}" (known: ${Object.keys(cfg.components).join(', ')})`)
  const text = String(process.env.DESCRIPTION ?? '').trim()
  const reasons = refuse(text)
  if (reasons.length) { console.error(`::error::not set: ${reasons.join('; ')}`); process.exit(1) }
  const before = await sp('GET', `/components/${id}`)
  const after = await sp('PATCH', `/components/${id}`, { component: { description: text } })
  if (after.description !== text) throw new Error(`Statuspage answered with description "${after.description}", not the one sent`)
  console.log(`${slug}: description "${before.description ?? ''}" -> "${after.description}"`)
}

if (process.argv[1]?.endsWith('component-description.mjs')) await main()
