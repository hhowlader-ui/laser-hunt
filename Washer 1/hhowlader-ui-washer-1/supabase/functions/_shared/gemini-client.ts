/**
 * gemini-client.ts — Shared Vertex AI / Gemini API client for Supabase Edge Functions
 * 
 * Drop this into: supabase/functions/_shared/gemini-client.ts
 * 
 * USAGE IN ANY EDGE FUNCTION:
 *   import { gemini, geminiWithSchema } from '../_shared/gemini-client.ts'
 *   const result = await gemini('gemini-2.5-flash', [{ role: 'user', parts: [{ text: 'Hello' }] }])
 *   console.log(result.text)
 * 
 * REQUIRED SUPABASE SECRETS (for Vertex AI):
 *   GCP_PROJECT_ID        — your Google Cloud project ID
 *   GCP_LOCATION           — e.g. us-central1, europe-west2
 *   GCP_SERVICE_ACCOUNT_KEY — the full JSON key file contents
 * 
 * OPTIONAL FALLBACK:
 *   GEMINI_API_KEY         — if set AND Vertex AI secrets are missing, falls back to Gemini Developer API
 *                            This lets you migrate app-by-app without breaking anything.
 * 
 * FEATURES:
 *   - Automatic Vertex AI auth with JWT signing (no SDK dependency)
 *   - Access token caching (~55 min lifetime, auto-refresh)
 *   - Automatic retry with exponential backoff on 429/5xx
 *   - Fallback to Gemini API key if Vertex AI not configured
 *   - Zero external dependencies (pure Deno/Web APIs)
 *   - System instruction support
 *   - JSON schema / structured output support
 */

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const GCP_PROJECT_ID = Deno.env.get('GCP_PROJECT_ID') ?? ''
const GCP_LOCATION = Deno.env.get('GCP_LOCATION') ?? 'us-central1'
const GCP_SERVICE_ACCOUNT_KEY = Deno.env.get('GCP_SERVICE_ACCOUNT_KEY') ?? ''
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''

const USE_VERTEX_AI = !!(GCP_PROJECT_ID && GCP_SERVICE_ACCOUNT_KEY)

const TOKEN_LIFETIME_SECS = 3600
const TOKEN_REFRESH_BUFFER_SECS = 300 // refresh 5 mins before expiry
const MAX_RETRIES = 3
const BASE_RETRY_DELAY_MS = 1000

// ─── TOKEN CACHE ─────────────────────────────────────────────────────────────

let cachedToken: string | null = null
let tokenExpiresAt = 0

// ─── CRYPTO HELPERS (Deno Web Crypto API) ────────────────────────────────────

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function base64urlEncodeString(str: string): string {
  return base64url(new TextEncoder().encode(str))
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0))

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
}

// ─── ACCESS TOKEN (JWT → OAuth2 token exchange) ─────────────────────────────

async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)

  // Return cached token if still valid
  if (cachedToken && now < tokenExpiresAt - TOKEN_REFRESH_BUFFER_SECS) {
    return cachedToken
  }

  const serviceAccount = JSON.parse(GCP_SERVICE_ACCOUNT_KEY)

  // Build JWT
  const header = base64urlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64urlEncodeString(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + TOKEN_LIFETIME_SECS,
    })
  )

  const signingInput = `${header}.${payload}`
  const key = await importPrivateKey(serviceAccount.private_key)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  )
  const jwt = `${signingInput}.${base64url(new Uint8Array(signature))}`

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.text()
    throw new Error(`Token exchange failed (${tokenRes.status}): ${err}`)
  }

  const tokenData = await tokenRes.json()
  cachedToken = tokenData.access_token
  tokenExpiresAt = now + (tokenData.expires_in ?? TOKEN_LIFETIME_SECS)

  return cachedToken!
}

// ─── REQUEST WITH RETRY ──────────────────────────────────────────────────────

async function fetchWithRetry(url: string, options: RequestInit): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options)

      // Success or client error (not retryable)
      if (res.ok || (res.status >= 400 && res.status < 429)) {
        return res
      }

      // Rate limited or server error — retry
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : BASE_RETRY_DELAY_MS * Math.pow(2, attempt)

        console.warn(
          `[gemini-client] ${res.status} on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delay}ms`
        )

        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, delay))

          // If 401/403, force token refresh on retry
          if (res.status === 401 || res.status === 403) {
            cachedToken = null
          }
          continue
        }
      }

      // Final attempt failed
      const errorBody = await res.text()
      throw new Error(`Gemini API error (${res.status}): ${errorBody}`)
    } catch (err) {
      lastError = err as Error
      if (attempt < MAX_RETRIES) {
        const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
    }
  }

  throw lastError ?? new Error('All retry attempts failed')
}

// ─── CORE API CALL ───────────────────────────────────────────────────────────

interface GeminiContent {
  role: string
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>
}

interface GeminiRequestBody {
  contents: GeminiContent[]
  systemInstruction?: { parts: Array<{ text: string }> }
  generationConfig?: Record<string, unknown>
  safetySettings?: Array<Record<string, unknown>>
}

interface GeminiResponse {
  /** Raw parsed JSON from the API */
  raw: Record<string, unknown>
  /** Extracted text from first candidate */
  text: string
  /** Usage metadata if available */
  usage?: {
    promptTokens?: number
    candidateTokens?: number
    totalTokens?: number
  }
}

async function callGemini(
  model: string,
  body: GeminiRequestBody
): Promise<GeminiResponse> {
  let url: string
  let headers: Record<string, string>

  if (USE_VERTEX_AI) {
    const token = await getAccessToken()
    url = `https://${GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_LOCATION}/publishers/google/models/${model}:generateContent`
    headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
  } else if (GEMINI_API_KEY) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
    headers = { 'Content-Type': 'application/json' }
  } else {
    throw new Error(
      '[gemini-client] No credentials configured. Set GCP_PROJECT_ID + GCP_SERVICE_ACCOUNT_KEY for Vertex AI, or GEMINI_API_KEY for fallback.'
    )
  }

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini ${res.status}: ${errText}`)
  }

  const raw = await res.json()

  // Extract text from response
  const text =
    raw?.candidates?.[0]?.content?.parts
      ?.map((p: Record<string, unknown>) => p.text ?? '')
      .join('') ?? ''

  // Extract usage
  const um = raw?.usageMetadata
  const usage = um
    ? {
        promptTokens: um.promptTokenCount,
        candidateTokens: um.candidatesTokenCount,
        totalTokens: um.totalTokenCount,
      }
    : undefined

  return { raw, text, usage }
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Simple text generation.
 *
 * @example
 *   const result = await gemini('gemini-2.5-flash', [
 *     { role: 'user', parts: [{ text: 'Summarise this document...' }] }
 *   ])
 *   console.log(result.text)
 */
export async function gemini(
  model: string,
  contents: GeminiContent[],
  options?: {
    systemInstruction?: string
    generationConfig?: Record<string, unknown>
    safetySettings?: Array<Record<string, unknown>>
  }
): Promise<GeminiResponse> {
  const body: GeminiRequestBody = { contents }

  if (options?.systemInstruction) {
    body.systemInstruction = { parts: [{ text: options.systemInstruction }] }
  }
  if (options?.generationConfig) {
    body.generationConfig = options.generationConfig
  }
  if (options?.safetySettings) {
    body.safetySettings = options.safetySettings
  }

  return callGemini(model, body)
}

/**
 * Structured output with JSON schema (Gemini 2.5+ feature).
 *
 * @example
 *   const result = await geminiWithSchema('gemini-2.5-flash', contents, {
 *     type: 'object',
 *     properties: { summary: { type: 'string' }, risk: { type: 'string', enum: ['low','medium','high'] } }
 *   })
 *   const parsed = JSON.parse(result.text)
 */
export async function geminiWithSchema(
  model: string,
  contents: GeminiContent[],
  schema: Record<string, unknown>,
  options?: {
    systemInstruction?: string
    safetySettings?: Array<Record<string, unknown>>
  }
): Promise<GeminiResponse> {
  return gemini(model, contents, {
    ...options,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
    },
  })
}

/**
 * Quick helper — single user prompt, returns text string.
 *
 * @example
 *   const summary = await geminiQuick('gemini-2.5-flash', 'Summarise: ...')
 */
export async function geminiQuick(
  model: string,
  prompt: string,
  systemInstruction?: string
): Promise<string> {
  const result = await gemini(
    model,
    [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction ? { systemInstruction } : undefined
  )
  return result.text
}

/**
 * Check which backend is active (useful for logging/debugging).
 */
export function geminiBackend(): 'vertex-ai' | 'gemini-api' | 'none' {
  if (USE_VERTEX_AI) return 'vertex-ai'
  if (GEMINI_API_KEY) return 'gemini-api'
  return 'none'
}
