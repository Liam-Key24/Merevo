import { NextResponse } from 'next/server'
import { isPlainObject } from '@/lib/isPlainObject'

const ALLOWED_EVENTS = new Set([
  'cta_click',
  'lead_submit_success',
  'external_booking_click',
])

type AnalyticsBody = {
  event?: unknown
  props?: unknown
}

export async function POST(request: Request) {
  let body: AnalyticsBody

  try {
    const parsed: unknown = await request.json()
    if (!isPlainObject(parsed)) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    body = parsed as AnalyticsBody
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const event = typeof body.event === 'string' ? body.event : ''
  if (!ALLOWED_EVENTS.has(event)) {
    return NextResponse.json({ error: 'Unknown event' }, { status: 400 })
  }

  const props =
    body.props && typeof body.props === 'object' && !Array.isArray(body.props)
      ? (body.props as Record<string, unknown>)
      : {}

  // Strip anything that looks like PII before optional forwarding
  const safeProps: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(props)) {
    if (key.toLowerCase().includes('email') || key.toLowerCase().includes('name')) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      safeProps[key] = value
    }
  }

  const webhook = process.env.ANALYTICS_WEBHOOK_URL
  if (webhook) {
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'merevo',
          event,
          props: safeProps,
          receivedAt: new Date().toISOString(),
        }),
      })
    } catch (error) {
      console.error('Analytics webhook failed:', error)
    }
  } else if (process.env.NODE_ENV === 'development') {
    console.info('[analytics]', event, safeProps)
  }

  return NextResponse.json({ ok: true })
}
