import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { StructuredInferenceError } from './StructuredInferenceError.js';

export function isPrivateOllamaAddress(address) {
  if (address === '::1') return true;
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 127 || first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function privateServiceUrl(value, allowedHostnames = []) {
  let url;
  try { url = new URL(value); } catch { throw new StructuredInferenceError('STRUCTURED_INFERENCE_CONFIGURATION'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !(isPrivateOllamaAddress(hostname) || ['localhost', ...allowedHostnames].includes(hostname))) {
    throw new StructuredInferenceError('STRUCTURED_INFERENCE_CONFIGURATION');
  }
  return url;
}

export function privateOllamaUrl(value) {
  return privateServiceUrl(value, ['ollama']);
}

/** A no-redirect transport which validates the addresses used by the socket.
 * The aliases below are private services declared in docker-compose.yml.
 */
export function createPrivateServiceFetch({ lookupImpl = lookup } = {}) {
  const privateLookup = (hostname, options, callback) => {
    lookupImpl(hostname, { all: true }, (error, addresses) => {
      if (error || !addresses?.length || addresses.some(item => !isPrivateOllamaAddress(item.address))) {
        callback(new StructuredInferenceError('STRUCTURED_INFERENCE_PROVIDER_UNAVAILABLE')); return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
  return function privateFetch(url, { method = 'GET', body, headers, signal } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      // Direct IP sockets can bypass DNS lookup; validate the origin here too.
      privateServiceUrl(target.origin, ['ollama', 'speech', 'kokoro']);
      if (target.username || target.password || target.hash) {
        throw new StructuredInferenceError('STRUCTURED_INFERENCE_CONFIGURATION');
      }
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method, headers, signal, lookup: privateLookup, agent: false,
      }, response => {
        try {
          const safeHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) safeHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const noBody = [204, 205, 304].includes(response.statusCode);
          if (noBody) response.resume();
          resolve(new Response(noBody ? null : Readable.toWeb(response), { status: response.statusCode, headers: safeHeaders }));
        } catch (error) {
          response.destroy(); reject(error);
        }
      });
      request.once('error', reject);
      request.end(body);
    });
  };
}

export const privateServiceFetch = createPrivateServiceFetch();
export const privateOllamaFetch = privateServiceFetch;
