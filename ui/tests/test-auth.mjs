import fs from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);
const authScript = fs.readFileSync(new URL('auth.js', root), 'utf8');

function response(status, payload = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return payload === null ? '' : JSON.stringify(payload); }
  };
}

async function createAuthPage(filename, url, submitResponse) {
  const calls = [];
  const navigations = [];
  const markup = fs.readFileSync(new URL(filename, root), 'utf8').replace(/<script src="auth\.js"><\/script>/, '');
  const dom = new JSDOM(markup, {
    url,
    runScripts: 'outside-only',
    beforeParse(window) {
      window.TextEncoder = globalThis.TextEncoder;
      window.VazheyarNavigate = (destination) => navigations.push(destination);
      window.fetch = async (path, options = {}) => {
        const method = options.method || 'GET';
        calls.push({ path: String(path), method, body: options.body ? JSON.parse(options.body) : null });
        if (path === '/api/auth/me') return response(401, { error: { code: 'UNAUTHENTICATED', message: 'Login required' } });
        return submitResponse(path, method);
      };
    }
  });
  dom.window.eval(authScript);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, calls, navigations };
}

const login = await createAuthPage(
  'login.html',
  'https://vazheyar.test/login.html?returnTo=%2Fapp%23reports',
  (path, method) => path === '/api/auth/login' && method === 'POST'
    ? response(200, { user: { id: 1, email: 'user@example.com' } })
    : response(404)
);
const loginInputs = [...login.dom.window.document.querySelectorAll('#authForm input')];
assert.deepEqual(loginInputs.map((input) => input.type), ['email', 'password'], 'Login must request only email and password');
login.dom.window.document.querySelector('#email').value = ' USER@example.COM ';
login.dom.window.document.querySelector('#password').value = 'correct-password';
login.dom.window.document.querySelector('#authForm').dispatchEvent(new login.dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
const loginCall = login.calls.find((call) => call.method === 'POST');
assert.equal(loginCall.path, '/api/auth/login');
assert.deepEqual(loginCall.body, { email: 'user@example.com', password: 'correct-password' });
assert.deepEqual(login.navigations, ['/app#reports'], 'Successful login must return to the safe local destination');

const maliciousRedirect = await createAuthPage(
  'login.html',
  'https://vazheyar.test/login.html?returnTo=%2F%5Cevil.example%2Fsteal',
  (path, method) => path === '/api/auth/login' && method === 'POST'
    ? response(200, { user: { id: 2, email: 'safe@example.com' } })
    : response(404)
);
maliciousRedirect.dom.window.document.querySelector('#email').value = 'safe@example.com';
maliciousRedirect.dom.window.document.querySelector('#password').value = 'correct-password';
maliciousRedirect.dom.window.document.querySelector('#authForm').dispatchEvent(
  new maliciousRedirect.dom.window.Event('submit', { bubbles: true, cancelable: true })
);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(maliciousRedirect.navigations, ['index.html'], 'Login must reject cross-origin backslash redirects');

const invalidEmail = await createAuthPage(
  'login.html',
  'https://vazheyar.test/login.html',
  () => response(500)
);
invalidEmail.dom.window.document.querySelector('#email').value = 'not-an-email';
invalidEmail.dom.window.document.querySelector('#password').value = 'correct-password';
invalidEmail.dom.window.document.querySelector('#authForm').dispatchEvent(
  new invalidEmail.dom.window.Event('submit', { bubbles: true, cancelable: true })
);
await new Promise((resolve) => setTimeout(resolve, 5));
assert.equal(invalidEmail.calls.filter((call) => call.method === 'POST').length, 0, 'Malformed email must be rejected before the API call');
assert.match(invalidEmail.dom.window.document.querySelector('#authMessage').textContent, /ایمیل معتبر/);

const register = await createAuthPage(
  'register.html',
  'https://vazheyar.test/register.html',
  (path, method) => path === '/api/auth/register' && method === 'POST'
    ? response(409, { error: { code: 'EMAIL_ALREADY_REGISTERED', message: 'This email is already registered.' } })
    : response(404)
);
const registerInputs = [...register.dom.window.document.querySelectorAll('#authForm input')];
assert.deepEqual(registerInputs.map((input) => input.type), ['email', 'password'], 'Register must request only email and password');
register.dom.window.document.querySelector('#email').value = 'existing@example.com';
register.dom.window.document.querySelector('#password').value = 'short';
register.dom.window.document.querySelector('#authForm').dispatchEvent(new register.dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 5));
assert.match(register.dom.window.document.querySelector('#authMessage').textContent, /حداقل ۸/);
assert.equal(register.calls.filter((call) => call.method === 'POST').length, 0, 'Short register passwords must be rejected before the API call');

register.dom.window.document.querySelector('#password').value = 'long-enough';
register.dom.window.document.querySelector('#authForm').dispatchEvent(new register.dom.window.Event('submit', { bubbles: true, cancelable: true }));
await new Promise((resolve) => setTimeout(resolve, 10));
const registerCall = register.calls.find((call) => call.method === 'POST');
assert.equal(registerCall.path, '/api/auth/register');
assert.deepEqual(registerCall.body, { email: 'existing@example.com', password: 'long-enough' });
assert.equal(register.navigations.length, 0, 'Failed registration must remain on the form');
assert.equal(register.dom.window.document.querySelector('#authMessage').textContent, 'این ایمیل قبلاً ثبت شده است.');
assert.equal(register.dom.window.document.querySelector('#authSubmit').disabled, false);

console.log('All Vazheyar authentication tests passed.');
