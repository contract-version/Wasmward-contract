import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRpcUrl, parseTimeout, valueAfter } from './cli-options.mjs';

test('valueAfter returns the next word', () => {
  assert.equal(valueAfter(['--config', 'a.json'], 0, '--config'), 'a.json');
  assert.equal(valueAfter(['x', '--min-days', '0', 'y'], 1, '--min-days'), '0');
});

test('valueAfter refuses a missing, empty, blank or option-looking value, naming the option', () => {
  for (const argv of [['--config'], ['--config', ''], ['--config', '   '], ['--config', '--json']]) {
    assert.throws(() => valueAfter(argv, 0, '--config'), /^Error: --config needs a value$/, JSON.stringify(argv));
  }
});

test('valueAfter accepts a value that merely starts with a single dash', () => {
  // A negative number is a value; whether it is acceptable is for the option to say.
  assert.equal(valueAfter(['--min-days', '-1'], 0, '--min-days'), '-1');
});

test('parseRpcUrl accepts http and https URLs, unchanged', () => {
  for (const url of ['https://soroban-testnet.stellar.org', 'http://127.0.0.1:8000/rpc', 'HTTPS://RPC.EXAMPLE.ORG/path?key=1']) {
    assert.equal(parseRpcUrl(url), url);
  }
});

test('parseRpcUrl refuses what is not an http(s) URL', () => {
  assert.throws(() => parseRpcUrl('not a url'), /--rpc-url is not a URL: not a url/);
  assert.throws(() => parseRpcUrl(''), /not a URL/);
  for (const other of ['file:///etc/passwd', 'ftp://example.org', 'javascript:alert(1)', 'ws://example.org']) {
    assert.throws(() => parseRpcUrl(other), /must start with https:\/\/ or http:\/\//, other);
  }
});

test('parseTimeout accepts whole milliseconds from 100 to 120000, inclusive', () => {
  assert.equal(parseTimeout('100'), 100);
  assert.equal(parseTimeout('15000'), 15_000);
  assert.equal(parseTimeout('120000'), 120_000);
});

test('parseTimeout refuses everything else', () => {
  for (const bad of ['99', '120001', '1.5', 'abc', '', '-5', 'Infinity', 'NaN', '1e3x']) {
    assert.throws(() => parseTimeout(bad), /--timeout-ms must be a whole number from 100 to 120000/, bad);
  }
});
