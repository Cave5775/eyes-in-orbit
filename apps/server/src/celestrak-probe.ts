/**
 * One request to CelesTrak, to tell "blocked" from "unreachable" from "fine":
 *   npm run celestrak:probe [-- <group>]        (default `stations`)
 * Prints the status, all response headers, the first 300 body characters, or the error with undici's cause code
 * (UND_ERR_CONNECT_TIMEOUT = the TCP connect never completed, i.e. an IP-level block or an egress problem; an HTTP 403
 * would be a rate limit). Exactly one request per run, same headers as the server, 20 s timeout.
 */
import { BODY_KEEP, TIMEOUT_MS, errorCauseCode, requestHeaders } from './http-util';

const group = process.argv[2] ?? 'stations';
if (!/^[a-z0-9-]+$/i.test(group)) {
  console.error(`invalid group name: ${group}`);
  process.exit(2);
}
const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=json`;
const headers = requestHeaders();
console.log(`GET ${url}`);
console.log(`request headers: ${JSON.stringify(headers)}`);

const started = Date.now();
try {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = await res.text();
  console.log(`status: ${res.status} ${res.statusText} (${Date.now() - started} ms)`);
  console.log('response headers:');
  for (const [k, v] of res.headers) console.log(`  ${k}: ${v}`);
  console.log(`body (first ${BODY_KEEP} of ${body.length} chars):`);
  console.log(body.slice(0, BODY_KEEP));
  process.exitCode = res.ok ? 0 : 1;
} catch (err) {
  const e = err as Error;
  const code = errorCauseCode(e);
  console.log(`FAILED after ${Date.now() - started} ms: ${e.name}: ${e.message}`);
  console.log(`cause code: ${code ?? '(none; ' + (e.name === 'TimeoutError' ? `the whole request exceeded ${TIMEOUT_MS / 1000} s` : 'see message') + ')'}`);
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') console.log('The TCP connect to celestrak.org:443 did not complete: blocked at IP level or no route from this network (not an HTTP 403).');
  process.exitCode = 1;
}
