// The component description check, offline. Run: node --test test/*.test.mjs
import { test } from 'node:test'
import assert from 'node:assert'
import { refuse, MAX_DESCRIPTION } from '../scripts/component-description.mjs'

test('a plain description passes', () => {
  assert.deepEqual(refuse('Our email server'), [])
  assert.deepEqual(refuse('The contact form on predivo.ch'), [])
})
test('an email address is refused - none is printed on a website', () => {
  assert.match(refuse('Email to hello@predivo.ch').join(), /email address/)
  assert.match(refuse('Schreiben Sie an info@example.com').join(), /email address/)
})
test('an empty, too long, key-shaped or IP-bearing description is refused', () => {
  assert.match(refuse('   ').join(), /missing/)
  assert.match(refuse('x'.repeat(MAX_DESCRIPTION + 1)).join(), /limit/)
  assert.match(refuse('ghp_abcdefghijklmnop').join(), /key or token/)
  assert.match(refuse('Mail server 80.74.145.155').join(), /IP address/)
})
