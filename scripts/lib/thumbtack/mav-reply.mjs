import { thumbtackMavTimeoutMs, thumbtackMavUrl } from './config.mjs';
import { generateFirstTouchReply } from './first-touch.mjs';

export async function generateMaverickReply(lead = {}, {
  fetchImpl = fetch,
  url = thumbtackMavUrl,
  timeoutMs = thumbtackMavTimeoutMs,
  fallback = generateFirstTouchReply,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        negotiationID: lead.negotiationID,
        customerName: lead.customerName,
        category: lead.category,
        text: lead.text,
        history: Array.isArray(lead.history) ? lead.history : [],
      }),
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`mav http ${response?.status || 'offline'}`);
    const json = await response.json();
    if (!json?.success || !json.reply) throw new Error(json?.error || 'empty mav reply');
    return { success: true, reply: String(json.reply), source: 'mav' };
  } catch (error) {
    const fallbackResult = fallback(lead);
    return {
      success: Boolean(fallbackResult?.success),
      reply: fallbackResult?.reply || '',
      source: fallbackResult?.source || 'first-touch-fallback',
      mavError: error?.name === 'AbortError' ? 'Agent timed out.' : String(error?.message || error),
    };
  } finally {
    clearTimeout(timer);
  }
}
