import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isPlainObject } from '@/lib/isPlainObject'
import { POST as analyticsPost } from './analytics/route'

describe('isPlainObject', () => {
  test('accepts plain objects only', () => {
    assert.equal(isPlainObject({ a: 1 }), true)
    assert.equal(isPlainObject(null), false)
    assert.equal(isPlainObject([]), false)
    assert.equal(isPlainObject('x'), false)
    assert.equal(isPlainObject(1), false)
  })
})

describe('analytics POST body guard', () => {
  async function post(body: unknown) {
    return analyticsPost(
      new Request('http://localhost/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    )
  }

  test('rejects null, arrays, and scalars with 400', async () => {
    for (const bad of [null, [], 'x', 1]) {
      const res = await post(bad)
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
      const json = (await res.json()) as { error: string }
      assert.equal(json.error, 'Invalid body')
    }
  })

  test('accepts a valid event body', async () => {
    const res = await post({ event: 'cta_click', props: { page: 'home' } })
    assert.equal(res.status, 200)
    const json = (await res.json()) as { ok: boolean }
    assert.equal(json.ok, true)
  })
})

describe('leads POST body guard', () => {
  test('rejects null, arrays, and scalars with 400', async () => {
    const { POST: leadsPost } = await import('./leads/route')
    for (const bad of [null, [], 'x', 1]) {
      const res = await leadsPost(
        new Request('http://localhost/api/leads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bad),
        })
      )
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`)
      const json = (await res.json()) as { error: string }
      assert.equal(json.error, 'Invalid request body.')
    }
  })
})
