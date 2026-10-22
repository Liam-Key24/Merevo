import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isPlainObject } from '@/lib/isPlainObject'
import { POST as analyticsPost } from './analytics/route'

vi.mock('@/lib/verifyTurnstile', () => ({
  verifyTurnstileToken: vi.fn(async () => true),
}))

vi.mock('@/lib/leadRateLimit', () => ({
  assertLeadRateLimit: vi.fn(async () => ({
    success: true,
    remaining: 4,
    reset: Date.now() + 60_000,
  })),
}))

vi.mock('@/lib/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(() => ({ mocked: true })),
}))

vi.mock('@/lib/leadSubmission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/leadSubmission')>()
  return {
    ...actual,
    createOrGetLeadByIdempotencyKey: vi.fn(async (_supabase, input) => ({
      lead: {
        id: 'lead-test-id',
        name: input.name,
        email: input.email,
        business_name: input.businessName || null,
        business_type: input.businessType || null,
        message: input.message,
        idempotency_key: input.idempotencyKey,
      },
      created: true,
    })),
    ensureLeadEmailsOnce: vi.fn(async () => undefined),
    getLeadEmailDeliveryState: vi.fn(async () => 'sent' as const),
  }
})

describe('isPlainObject', () => {
  it('accepts plain objects only', () => {
    expect(isPlainObject({ a: 1 })).toBe(true)
    expect(isPlainObject(null)).toBe(false)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject('x')).toBe(false)
    expect(isPlainObject(1)).toBe(false)
  })
})

describe('analytics POST body guard', () => {
  async function post(body: unknown) {
    return analyticsPost(
      new Request('http://localhost/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  it('rejects null, arrays, and scalars with 400', async () => {
    for (const bad of [null, [], 'x', 1]) {
      const res = await post(bad)
      expect(res.status, `expected 400 for ${JSON.stringify(bad)}`).toBe(400)
      const json = (await res.json()) as { error: string }
      expect(json.error).toBe('Invalid body')
    }
  })

  it('accepts a valid event body', async () => {
    const res = await post({ event: 'cta_click', props: { page: 'home' } })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean }
    expect(json.ok).toBe(true)
  })
})

describe('leads POST body guard', () => {
  beforeEach(() => {
    process.env.LEAD_IP_HASH_SALT = 'test-salt'
    vi.clearAllMocks()
  })

  async function post(body: unknown) {
    const { POST: leadsPost } = await import('./leads/route')
    return leadsPost(
      new Request('http://localhost/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
  }

  it('rejects null, arrays, and scalars with 400', async () => {
    for (const bad of [null, [], 'x', 1]) {
      const res = await post(bad)
      expect(res.status, `expected 400 for ${JSON.stringify(bad)}`).toBe(400)
      const json = (await res.json()) as { error: string }
      expect(json.error).toBe('Invalid request body.')
    }
  })

  it('accepts a valid lead body', async () => {
    const res = await post({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      businessName: 'Analytical Engines',
      businessType: 'other',
      message: 'Looking for a booking demo next week.',
      turnstileToken: 'test-turnstile-token',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      id: string
      confirmationDelivery: string
    }
    expect(json.ok).toBe(true)
    expect(json.id).toBe('lead-test-id')
    expect(json.confirmationDelivery).toBe('sent')
  })
})
