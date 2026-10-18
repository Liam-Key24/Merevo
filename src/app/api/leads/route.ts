import { NextResponse } from 'next/server'
import { getClientIp, hashIp } from '@/lib/clientIp'
import { isPlainObject } from '@/lib/isPlainObject'
import { assertLeadRateLimit } from '@/lib/leadRateLimit'
import { isValidLeadBusinessType } from '@/lib/leadBusinessTypes'
import {
  createOrGetLeadByIdempotencyKey,
  ensureLeadEmailsOnce,
  getLeadEmailDeliveryState,
  isValidIdempotencyKey,
  LEAD_DELIVERY_ISSUE_MESSAGE,
} from '@/lib/leadSubmission'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'
import { verifyTurnstileToken } from '@/lib/verifyTurnstile'

const MAX_NAME = 120
const MAX_EMAIL = 254
const MAX_BUSINESS_NAME = 160
const MAX_MESSAGE = 4000

type LeadBody = {
  name?: unknown
  email?: unknown
  businessName?: unknown
  businessType?: unknown
  message?: unknown
  turnstileToken?: unknown
  idempotencyKey?: unknown
  website?: unknown // honeypot
}

function asTrimmedString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function safeError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

/** Enquiry saved; confirmation email did not fully succeed. Same for first try and idempotent retries. */
function deliveryIssueResponse(leadId: string) {
  return NextResponse.json(
    {
      ok: true,
      id: leadId,
      received: true,
      confirmationDelivery: 'failed',
      message: LEAD_DELIVERY_ISSUE_MESSAGE,
    },
    { status: 200 },
  )
}

export async function POST(request: Request) {
  let body: LeadBody

  try {
    const parsed: unknown = await request.json()
    if (!isPlainObject(parsed)) {
      return safeError('Invalid request body.', 400)
    }
    body = parsed as LeadBody
  } catch {
    return safeError('Invalid request body.', 400)
  }

  // Honeypot — bots fill hidden fields; humans leave empty
  if (asTrimmedString(body.website).length > 0) {
    return NextResponse.json({ ok: true })
  }

  const name = asTrimmedString(body.name)
  const email = asTrimmedString(body.email).toLowerCase()
  const businessName = asTrimmedString(body.businessName)
  const businessType = asTrimmedString(body.businessType).toLowerCase()
  const message = asTrimmedString(body.message)
  const turnstileToken = asTrimmedString(body.turnstileToken)
  const idempotencyKey = asTrimmedString(body.idempotencyKey)

  if (name.length < 2 || name.length > MAX_NAME) {
    return safeError('Please enter your name.', 400)
  }

  if (!isValidEmail(email) || email.length > MAX_EMAIL) {
    return safeError('Please enter a valid email.', 400)
  }

  if (businessName.length > MAX_BUSINESS_NAME) {
    return safeError('Business name is too long.', 400)
  }

  if (businessType && !isValidLeadBusinessType(businessType)) {
    return safeError('Please choose a valid business type.', 400)
  }

  if (message.length < 10 || message.length > MAX_MESSAGE) {
    return safeError('Please add a short message (10–4000 characters).', 400)
  }

  if (!isValidIdempotencyKey(idempotencyKey)) {
    return safeError('Invalid submission. Please refresh and try again.', 400)
  }

  if (!turnstileToken) {
    return safeError('Please complete the security check.', 400)
  }

  const ip = getClientIp(request)

  try {
    let ipHash: string
    try {
      ipHash = hashIp(ip)
    } catch {
      console.error('LEAD_IP_HASH_SALT is not configured')
      return safeError('Something went wrong. Please try again in a moment.', 500)
    }

    try {
      const limit = await assertLeadRateLimit(ipHash)
      if (!limit.success) {
        return safeError('Too many messages. Please wait a few minutes and try again.', 429)
      }
    } catch (rateError) {
      console.error('Lead rate limit failed:', rateError)
      return safeError('Something went wrong. Please try again in a moment.', 500)
    }

    let turnstileOk = false
    try {
      turnstileOk = await verifyTurnstileToken(turnstileToken, ip)
    } catch (turnstileError) {
      console.error('Turnstile verification failed:', turnstileError)
      return safeError('Something went wrong. Please try again in a moment.', 500)
    }

    if (!turnstileOk) {
      return safeError('Security check failed. Please try again.', 400)
    }

    const supabase = getSupabaseAdmin()
    let lead
    let created: boolean

    try {
      ;({ lead, created } = await createOrGetLeadByIdempotencyKey(supabase, {
        name,
        email,
        businessName,
        businessType,
        message,
        idempotencyKey,
        source: 'website',
      }))
    } catch (insertError) {
      console.error('Supabase lead insert failed:', insertError)
      return safeError('Could not save your message. Please try again.', 500)
    }

    // Attempt sends at most once; replays skip existing delivery rows (no auto-retry).
    await ensureLeadEmailsOnce(supabase, lead)

    const deliveryState = await getLeadEmailDeliveryState(supabase, lead.id)

    if (deliveryState === 'delivery_issue') {
      if (created) {
        console.error('Lead email delivery incomplete (recorded for manual review):', {
          leadId: lead.id,
        })
      }
      return deliveryIssueResponse(lead.id)
    }

    return NextResponse.json({
      ok: true,
      id: lead.id,
      received: true,
      confirmationDelivery: 'sent',
    })
  } catch (error) {
    console.error('Lead submission failed:', error)
    return safeError('Something went wrong. Please try again in a moment.', 500)
  }
}
