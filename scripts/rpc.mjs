// Asking a Stellar RPC for one ledger entry, with no dependencies. Shared by the scripts that read the network.

/** One attempt. `retryable` on the error says whether trying again could help. */
async function rpcAttempt(rpcUrl, key, timeoutMs) {
  let response;
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLedgerEntries', params: { keys: [key] } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    // Network failure or timeout: a second try may well work.
    throw Object.assign(new Error(`could not reach the RPC: ${cause.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : cause.message}`), { retryable: true });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`the RPC answered HTTP ${response.status}`), { retryable: response.status >= 500 || response.status === 429 });
  }
  let body;
  try {
    body = await response.json();
  } catch {
    // A gateway's error page served with a 200, or a cut-off reply: worth one more try.
    throw Object.assign(new Error('the RPC answered something that is not JSON'), { retryable: true });
  }
  if (body?.error !== undefined) throw new Error(`the RPC returned an error: ${body.error.message ?? JSON.stringify(body.error)}`);
  // Without this, an empty answer would reach the caller as "no such entry", which says something untrue.
  if (body?.result === undefined || body.result === null) throw new Error('the RPC answered without a result');
  return body.result;
}

/**
 * Asks the RPC for one ledger entry. A busy or briefly unreachable RPC is tried again (default: once more,
 * after half a second); an answer that is wrong is not, because asking again would not change it.
 */
export async function rpcLookup(rpcUrl, key, { timeoutMs = 15_000, retries = 1, delayMs = 500 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rpcAttempt(rpcUrl, key, timeoutMs);
    } catch (error) {
      if (!error.retryable || attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
