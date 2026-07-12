(() => {
  'use strict';

  const form = document.querySelector('#authForm');
  const emailInput = document.querySelector('#email');
  const passwordInput = document.querySelector('#password');
  const submitButton = document.querySelector('#authSubmit');
  const message = document.querySelector('#authMessage');
  const mode = document.body.dataset.authMode === 'register' ? 'register' : 'login';
  const navigate = typeof window.VazheyarNavigate === 'function'
    ? window.VazheyarNavigate
    : (destination) => location.replace(destination);
  const errorMessages = {
    INVALID_CREDENTIALS: 'ایمیل یا رمز عبور درست نیست.',
    EMAIL_ALREADY_REGISTERED: 'این ایمیل قبلاً ثبت شده است.',
    INVALID_EMAIL: 'یک ایمیل معتبر وارد کن.',
    INVALID_PASSWORD: 'رمز عبور باید حداقل ۸ کاراکتر و حداکثر ۷۲ بایت باشد.',
    AUTH_RATE_LIMITED: 'تعداد تلاش‌ها زیاد شده است؛ کمی بعد دوباره امتحان کن.'
  };

  function safeDestination() {
    const requested = new URLSearchParams(location.search).get('returnTo');
    if (!requested || !requested.startsWith('/')) return 'index.html';

    try {
      const destination = new URL(requested, location.origin);
      if (destination.origin !== location.origin) return 'index.html';
      return `${destination.pathname}${destination.search}${destination.hash}`;
    } catch {
      return 'index.html';
    }
  }

  function setMessage(text = '', isError = false) {
    message.textContent = text;
    message.classList.toggle('error', isError);
    message.hidden = !text;
  }

  function setLoading(loading) {
    submitButton.disabled = loading;
    submitButton.classList.toggle('loading', loading);
    submitButton.querySelector('.button-label').textContent = loading
      ? (mode === 'register' ? 'در حال ساخت حساب…' : 'در حال ورود…')
      : (mode === 'register' ? 'ساخت حساب' : 'ورود به واژه‌یار');
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'include',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const raw = response.status === 204 ? '' : await response.text();
    let payload = null;
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch { throw new Error('پاسخ نامعتبر از سرور دریافت شد.'); }
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.message || 'درخواست انجام نشد. دوباره تلاش کن.');
      error.status = response.status;
      error.code = payload?.error?.code || 'API_ERROR';
      throw error;
    }
    return payload;
  }

  async function checkExistingSession() {
    try {
      await request('/api/auth/me');
      navigate(safeDestination());
    } catch (error) {
      if (error.status !== 401) setMessage('اتصال به سرور برقرار نشد. می‌توانی دوباره تلاش کنی.', true);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setMessage();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;
    if (!email || !password) {
      setMessage('ایمیل و رمز عبور را وارد کن.', true);
      return;
    }
    if (!emailInput.validity.valid) {
      setMessage('یک ایمیل معتبر وارد کن.', true);
      emailInput.focus();
      return;
    }
    if (mode === 'register' && password.length < 8) {
      setMessage('رمز عبور باید حداقل ۸ کاراکتر داشته باشد.', true);
      passwordInput.focus();
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      setMessage(mode === 'register'
        ? 'رمز عبور نباید بیشتر از ۷۲ بایت باشد.'
        : 'ایمیل یا رمز عبور درست نیست.', true);
      passwordInput.focus();
      return;
    }
    setLoading(true);
    try {
      await request(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      navigate(safeDestination());
    } catch (error) {
      setMessage(errorMessages[error.code] || error.message, true);
      setLoading(false);
      passwordInput.focus();
    }
  });

  checkExistingSession();
})();
