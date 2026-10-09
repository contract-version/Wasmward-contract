// Reading the options the network scripts have in common, so they all accept and refuse the same things.

/**
 * The value of the option at `argv[index]`, which is the next word. It must exist, must not be empty and must
 * not be another option. (An empty value would otherwise read as 0 and quietly change what is checked.)
 */
export function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** An http(s) URL, returned as it was written. */
export function parseRpcUrl(text) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`--rpc-url is not a URL: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--rpc-url must start with https:// or http://');
  return text;
}

/** How long to wait for one answer, in whole milliseconds: from 100 to 120000 (two minutes). */
export function parseTimeout(text) {
  const ms = Number(text);
  if (!Number.isInteger(ms) || ms < 100 || ms > 120_000) throw new Error('--timeout-ms must be a whole number from 100 to 120000');
  return ms;
}
