import { FILING_RULES } from "../constants";
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabaseClient";

export interface FileAnalysisResult {
  originalName: string;
  newName: string;
  isDifferentCompany?: boolean;
  companyName?: string;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getValidToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    const expiresAt = session.expires_at ?? 0;
    const now = Math.floor(Date.now() / 1000);
    if (expiresAt - now > 60) return session.access_token;
  }
  const { data: { session: refreshed }, error } = await supabase.auth.refreshSession();
  if (error || !refreshed?.access_token) {
    await supabase.auth.signOut();
    throw new Error('Session expired. Please sign in again.');
  }
  return refreshed.access_token;
}

function buildInstructions(fallbackDate: string, companyName: string, hasImageContent: boolean): string {
  const isOpsMode = !companyName.trim();

  let instructions = `Apply protocol v4.8 strictly.
    CRITICAL RULES:
    1. EXACTLY ONE DATE at the very end in DD.MM.YYYY format (e.g. 31.03.2026). No other dates allowed.
    2. DATE EXTRACTION IS CRITICAL: You MUST extract the date from the document content or original filename. ONLY use the Fallback Date (${fallbackDate}) if it is IMPOSSIBLE to find a date in the document.
    3. NO DUPLICATE WORDS. Do not repeat the document type in the detail section.
    4. Use " - " as the exact separator.
    5. PAY CLOSE ATTENTION TO THE ORIGINAL FILENAME for context (e.g. if it says "Payslip", it is [FI] Payslips (Indiv), NOT [FM] Payroll Summary).
    ${isOpsMode
      ? `6. EXTRACT the company name from the document (letterhead, header, addressee, invoice "To:" field, or any company reference) and return it in the companyName field. This is CRITICAL — look hard for any company name.
    7. Set isDifferentCompany to false.`
      : `6. DO NOT include the company name ("${companyName}") in the renamed file.
    7. If the document appears to belong to a completely different company (not "${companyName}"), set isDifferentCompany to true.
    8. Return the company name you identified in the companyName field.`
    }
    Return JSON only.`;

  if (hasImageContent) {
    instructions += `

    IMAGE/SCAN OCR INSTRUCTIONS:
    - Perform careful OCR on the entire visible content.
    - Look specifically for: dates (in any format), letterheads, logos, company names, reference numbers, invoice numbers, account numbers.
    - Identify the document type from visual cues: letterhead style, layout, stamps, signatures, table structures.
    - Check all corners and margins for dates, page numbers, or reference codes.
    - Pay attention to any watermarks, stamps, or handwritten annotations.`;
  }

  return instructions;
}

export async function processFile(
  content: string | { data: string, mimeType: string } | { parts: any[] },
  originalFilename: string,
  fallbackDate: string,
  companyName: string
): Promise<FileAnalysisResult> {

  const lastDotIndex = originalFilename.lastIndexOf('.');
  const ext = lastDotIndex !== -1 ? originalFilename.substring(lastDotIndex + 1).toLowerCase() : '';

  let finalParts: any[] = [];
  if (typeof content === 'object' && 'parts' in content) {
    finalParts = content.parts;
  } else if (typeof content === 'string') {
    finalParts.push({ text: content.substring(0, 30000) });
  } else {
    finalParts.push({ inlineData: { data: content.data, mimeType: content.mimeType } });
  }

  const hasImageContent = finalParts.some(part => part.inlineData !== undefined);
  const systemInstruction = `${FILING_RULES}\n\n${buildInstructions(fallbackDate, companyName, hasImageContent)}`;

  let lastError: any = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const token = await getValidToken();
      const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/process-file`;
      const requestBody = JSON.stringify({ parts: finalParts, systemInstruction });

      let res = await fetch(edgeFunctionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': SUPABASE_ANON_KEY,
        },
        body: requestBody,
      });

      // 401 retry: refresh token and try once more
      if (res.status === 401) {
        const { data: { session: refreshed } } = await supabase.auth.refreshSession();
        if (!refreshed?.access_token) {
          await supabase.auth.signOut();
          throw new Error('Session expired. Please sign in again.');
        }
        res = await fetch(edgeFunctionUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${refreshed.access_token}`,
            'apikey': SUPABASE_ANON_KEY,
          },
          body: requestBody,
        });
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server error ${res.status}: ${errText}`);
      }

      const result = await res.json();

      if (result.error) throw new Error(result.error);

      let cleanName = (result.newName || originalFilename).trim().replace(/[:\\/*?"<>|]/g, '');
      if (ext && !cleanName.toLowerCase().endsWith(`.${ext}`)) cleanName = `${cleanName}.${ext}`;

      return {
        originalName: originalFilename,
        newName: cleanName,
        isDifferentCompany: result.isDifferentCompany || false,
        companyName: result.companyName || ''
      };

    } catch (err: any) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        console.warn(`Attempt ${attempt + 1} failed, retrying...`, err.message);
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError;
}
