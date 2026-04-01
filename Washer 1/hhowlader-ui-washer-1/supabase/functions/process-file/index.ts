import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import { gemini } from "../_shared/gemini-client.ts"

// ─── CORS ────────────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// ─── CLAUDE FALLBACK ─────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? ""
const CLAUDE_MODEL = "claude-sonnet-4-6"

interface ContentPart {
  text?: string
  inlineData?: { data: string; mimeType: string }
}

async function tryClaude(
  parts: ContentPart[],
  systemInstruction: string
): Promise<string> {
  const contentBlocks: Record<string, unknown>[] = []

  for (const part of parts) {
    if (part.text) {
      contentBlocks.push({ type: "text", text: part.text })
    } else if (part.inlineData) {
      if (part.inlineData.mimeType.startsWith("image/")) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.inlineData.mimeType,
            data: part.inlineData.data,
          },
        })
      }
    }
  }

  if (contentBlocks.length === 0) {
    throw new Error("No content for Claude fallback")
  }

  contentBlocks.push({
    type: "text",
    text: `Return a JSON object with exactly three fields: "newName" (string), "isDifferentCompany" (boolean), and "companyName" (string — the company this document relates to, extracted from the document). No markdown, no explanation.`,
  })

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: systemInstruction,
      messages: [{ role: "user", content: contentBlocks }],
    }),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Claude ${res.status}: ${err}`)
  }

  const data = await res.json()
  return data.content?.[0]?.text || "{}"
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405)
  }

  try {
    // ── Auth ──────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, 401)
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    )

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401)
    }

    // ── Parse request ────────────────────────────────────────────────────
    const { parts, systemInstruction } = await req.json()

    if (!parts || !Array.isArray(parts)) {
      return jsonResponse({ error: "Missing or invalid 'parts' array" }, 400)
    }

    // ── Try Gemini (Vertex AI) then Claude fallback ──────────────────────
    let rawText: string
    let usedFallback = false

    try {
      const result = await gemini("gemini-2.5-flash", [{ role: "user", parts }], {
        systemInstruction,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              newName: { type: "STRING" },
              isDifferentCompany: { type: "BOOLEAN" },
              companyName: { type: "STRING" },
            },
            required: ["newName", "isDifferentCompany", "companyName"],
          },
        },
      })
      rawText = result.text
    } catch (geminiErr) {
      console.warn(
        "[process-file] Gemini failed, trying Claude:",
        (geminiErr as Error).message
      )
      usedFallback = true
      rawText = await tryClaude(parts, systemInstruction)
    }

    // ── Parse JSON from model response ───────────────────────────────────
    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/)
      if (match) {
        parsed = JSON.parse(match[0])
      } else {
        throw new Error("Invalid JSON from model")
      }
    }

    // ── Audit log (non-blocking) ───────────────────────────────────────
    const hasInlineData = parts.some(
      (p: ContentPart) => p.inlineData !== undefined
    )
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    )
    adminClient
      .from("audit_log")
      .insert({
        user_id: user.id,
        user_email: user.email || user.user_metadata?.email,
        action: "file_renamed",
        document_type: hasInlineData ? "binary/vision" : "text",
        page_count: 1,
        file_count: 1,
        consent_given: true,
        created_at: new Date().toISOString(),
      })
      .then(({ error: auditErr }) => {
        if (auditErr)
          console.error("[process-file] audit log failed:", auditErr.message)
      })

    return jsonResponse({ ...parsed, usedFallback })
  } catch (err) {
    console.error("[process-file] Error:", (err as Error).message)
    return jsonResponse(
      { error: (err as Error).message || "Unknown error" },
      500
    )
  }
})
