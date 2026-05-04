import { chromium } from 'playwright';

class ChainauthCancelledError extends Error {
  constructor(message = 'Workflow gestopt vanuit GRANTLY.', stoppedAfter = 'cancelled', currentUrl = '') {
    super(message);
    this.name = 'ChainauthCancelledError';
    this.stoppedAfter = stoppedAfter;
    this.currentUrl = currentUrl;
  }
}

function coerceTimeout(payload) {
  const timeout = Number(payload.timeout_ms || 45000);
  return Math.max(5000, Math.min(120000, Number.isFinite(timeout) ? timeout : 45000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepWithCancel(ms, payload, page = null, stoppedAfter = 'cancelled') {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    await assertNotCancelled(payload, page, stoppedAfter);
  }
}

async function withCancellation(promise, payload, page = null, stoppedAfter = 'cancelled') {
  let finished = false;

  const cancelWatcher = (async () => {
    while (!finished) {
      await sleep(500);
      await assertNotCancelled(payload, page, stoppedAfter);
    }
  })();

  try {
    return await Promise.race([promise, cancelWatcher]);
  } finally {
    finished = true;
  }
}

async function postCallback(payload, body) {
  if (!payload.callback_url) {
    return;
  }

  await fetch(payload.callback_url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${payload.callback_token || ''}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider_id: payload.provider_id || null,
      ...body,
    }),
  }).catch((error) => {
    console.log(`Callback failed: ${error.message}`);
  });
}

async function fetchMfaState(payload) {
  const pollUrl = payload.mfa_code_url;
  if (!pollUrl) {
    return { ok: true, data: null, status: 0 };
  }

  const url = new URL(pollUrl);
  url.searchParams.set('provider_id', String(payload.provider_id || ''));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${payload.callback_token || ''}`,
      'Accept': 'application/json',
    },
  }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));

  const data = await res.json().catch(() => null);

  return { ok: !!res.ok, status: Number(res.status || 0), data, res };
}

async function assertNotCancelled(payload, page = null, stoppedAfter = 'cancelled') {
  if (!payload.mfa_code_url) {
    return;
  }

  const state = await fetchMfaState(payload);
  if (state.data && state.data.cancelled) {
    const currentUrl = page ? page.url() : '';
    throw new ChainauthCancelledError(
      state.data.message || 'Workflow gestopt vanuit GRANTLY.',
      stoppedAfter,
      currentUrl
    );
  }
}

async function pollForMfaCode(payload, timeout, page = null) {
  const pollUrl = payload.mfa_code_url;
  if (!pollUrl) {
    console.log('MFA polling disabled: missing mfa_code_url');
    return null;
  }

  const deadline = Date.now() + Number(payload.mfa_poll_timeout_ms || 480000);
  const interval = Math.max(1000, Number(payload.mfa_poll_interval_ms || 3000));

  while (Date.now() < deadline) {
    const state = await fetchMfaState(payload);
    const data = state.data;

    if (data && data.cancelled) {
      console.log('MFA workflow was cancelled from GRANTLY.');
      return { cancelled: true, message: data.message || 'Workflow gestopt vanuit GRANTLY.' };
    }

    if (state.ok) {
      if (data && data.success && data.code) {
        console.log('MFA code received from GRANTLY, continuing same browser session.');
        return String(data.code).trim();
      }
      console.log('MFA code pending...');
    } else {
      const text = data ? JSON.stringify(data) : await state.res?.text?.().catch(() => '');
      console.log(`MFA poll status: ${state.status} ${text || ''}`);
    }

    await sleepWithCancel(interval, payload, page, 'sms_mfa_cancelled');
  }

  return null;
}

async function isInvalidSmsCodeVisible(page, payload, timeout) {
  const invalidSelector = payload.sms_invalid_selector || [
    '.validation-summary-errors',
    '.field-validation-error',
    '.text-danger',
    '.alert-danger',
    '.error',
    '[role="alert"]',
  ].join(', ');

  const invalidText = payload.sms_invalid_text || /ongeldig|onjuist|incorrect|invalid|verkeerd|fout|niet juist|probeer opnieuw/i;

  const visibleError = await page.locator(invalidSelector).filter({ hasText: invalidText }).first().isVisible({ timeout: 1500 }).catch(() => false);
  if (visibleError) {
    return true;
  }

  const bodyText = await page.locator('body').innerText({ timeout: 1500 }).catch(() => '');
  if (invalidText.test(bodyText)) {
    return true;
  }

  const smsUrl = /\/Login\/nl\/Login\/SMS/i.test(page.url());
  const inputStillVisible = await page.locator(payload.sms_selector || [
    'input#Code',
    'input[name="Code"]',
    'input[name="SmsCode"]',
    'input[name="SMSCode"]',
    'input[name*="code" i]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[type="text"]',
  ].join(', ')).first().isVisible({ timeout: 1500 }).catch(() => false);

  return smsUrl && inputStillVisible;
}

async function completeSmsMfa(page, payload, timeout) {
  const smsSelector = payload.sms_selector || [
    'input#Code',
    'input[name="Code"]',
    'input[name="SmsCode"]',
    'input[name="SMSCode"]',
    'input[name*="code" i]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[type="text"]',
  ].join(', ');

  const submitSelector = payload.sms_submit_selector || [
    'button[name="login"]',
    'button[name="submit"]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Bevestigen")',
    'button:has-text("Doorgaan")',
    'button:has-text("Inloggen")',
  ].join(', ');

  const maxAttempts = Math.max(1, Math.min(5, Number(payload.sms_max_attempts || 3)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await assertNotCancelled(payload, page, 'sms_mfa_cancelled');
    const smsCode = await pollForMfaCode(payload, timeout, page);

    if (smsCode && typeof smsCode === 'object' && smsCode.cancelled) {
      return {
        success: false,
        mfa_required: false,
        cancelled: true,
        status: 'cancelled',
        message: smsCode.message || 'Workflow gestopt vanuit GRANTLY.',
        current_url: page.url(),
        stopped_after: 'sms_mfa_cancelled',
      };
    }

    if (!smsCode) {
      return {
        success: false,
        mfa_required: true,
        status: 'mfa_required',
        message: 'SMS-code vereist maar niet op tijd ontvangen in GRANTLY.',
        current_url: page.url(),
        stopped_after: 'sms_mfa_timeout',
      };
    }

    await page.locator(smsSelector).first().waitFor({ state: 'visible', timeout });
    await page.locator(smsSelector).first().fill('', { timeout }).catch(() => {});
    await page.locator(smsSelector).first().fill(smsCode, { timeout });

    await withCancellation(Promise.allSettled([
      page.locator(submitSelector).first().click({ timeout }),
      page.waitForLoadState('networkidle', { timeout }),
    ]), payload, page, 'submit_sms_code');

    await sleepWithCancel(2500, payload, page, 'sms_mfa_cancelled');

    if (await isInvalidSmsCodeVisible(page, payload, timeout)) {
      const message = attempt >= maxAttempts
        ? 'SMS-code is ongeldig. Maximaal aantal pogingen bereikt.'
        : 'SMS-code is ongeldig of geweigerd. Vul een nieuwe SMS-code in GRANTLY in.';

      await postCallback(payload, {
        status: attempt >= maxAttempts ? 'failed' : 'sms_invalid_code',
        success: false,
        mfa_required: attempt < maxAttempts,
        message,
        current_url: page.url(),
        stopped_after: 'sms_mfa_invalid_code',
      });

      if (attempt >= maxAttempts) {
        return {
          success: false,
          mfa_required: false,
          status: 'failed',
          message,
          current_url: page.url(),
          stopped_after: 'sms_mfa_invalid_code',
        };
      }

      await page.locator(smsSelector).first().fill('', { timeout: 1500 }).catch(() => {});
      console.log('Invalid SMS code detected; waiting for a new MFA code from GRANTLY.');
      continue;
    }

    return null;
  }

  return {
    success: false,
    mfa_required: false,
    status: 'failed',
    message: 'SMS-code kon niet worden bevestigd.',
    current_url: page.url(),
    stopped_after: 'sms_mfa_failed',
  };
}

async function navigateToLoginScreen(page, payload, timeout) {
  if (payload.login_url && payload.login_url !== payload.start_url) {
    await withCancellation(page.goto(payload.login_url, { waitUntil: 'domcontentloaded', timeout }), payload, page, 'goto_login_url');
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    console.log('URL AFTER LOGIN_URL GOTO:', page.url());
    return;
  }

  if (payload.login_click_selector) {
    const link = page.locator(payload.login_click_selector).first();
    const href = await link.getAttribute('href').catch(() => null);

    if (href) {
      await withCancellation(page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout }), payload, page, 'goto_login_href');
    } else {
      await withCancellation(link.click({ timeout }), payload, page, 'click_login_link');
      await withCancellation(page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {}), payload, page, 'after_click_login_link');
    }

    console.log('URL AFTER LOGIN CLICK:', page.url());
    return;
  }

  const directLoginLink = page
    .locator('a[href*="/Login/nl/Login/UsernamePassword"], a[href*="login.zlogin.nl"][href*="UsernamePassword"]')
    .first();

  if (await directLoginLink.count()) {
    const href = await directLoginLink.getAttribute('href').catch(() => null);
    if (href) {
      await withCancellation(page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout }), payload, page, 'goto_login_href');
      console.log('URL AFTER ZLOGIN DIRECT LOGIN LINK:', page.url());
      return;
    }
  }

  const candidates = [
    page.getByRole('link', { name: /mijn z login|inloggen|login|sign in/i }),
    page.getByRole('button', { name: /inloggen|login|sign in/i }),
    page.locator('a[href*="UsernamePassword"], a[href*="login" i], button:has-text("Login"), button:has-text("Inloggen")').first(),
  ];

  for (const locator of candidates) {
    try {
      const item = locator.first();
      if (await item.isVisible({ timeout: 2500 })) {
        const href = await item.getAttribute('href').catch(() => null);
        if (href) {
          await withCancellation(page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout }), payload, page, 'goto_login_href');
        } else {
          await withCancellation(item.click({ timeout: 5000 }), payload, page, 'click_auto_login');
          await withCancellation(page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {}), payload, page, 'after_click_auto_login');
        }
        console.log('URL AFTER AUTO LOGIN NAV:', page.url());
        return;
      }
    } catch (_) {
      // Candidate not present; continue.
    }
  }
}

async function waitForLoginForm(page, payload, timeout) {
  const usernameSelector = payload.username_selector || [
    'input#Name[name="Name"]',
    'input[name="Name"]',
    'input[placeholder="Gebruikersnaam"]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="email"]',
  ].join(', ');

  const passwordSelector = payload.password_selector || [
    'input#Password[name="Password"]',
    'input[name="Password"]',
    'input[placeholder="Wachtwoord"]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ].join(', ');

  await page.locator(usernameSelector).first().waitFor({ state: 'visible', timeout });
  await page.locator(passwordSelector).first().waitFor({ state: 'visible', timeout });

  return { usernameSelector, passwordSelector };
}

export async function runZloginLoginTest(payload) {
  const timeout = coerceTimeout(payload);
  const startUrl = payload.start_url || payload.login_url || 'https://zlogin.nl/';
  const submitSelector = payload.submit_selector || 'button.main-btn[name="login"], button[name="login"], button[type="submit"], input[type="submit"]';

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1365, height: 900 },
    userAgent: payload.user_agent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Grantly ChainAuth Worker/0.1',
  });

  const page = await context.newPage();

  try {
    await assertNotCancelled(payload, page, 'before_start');

    await withCancellation(page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout }), payload, page, 'start_goto');
    console.log('URL AFTER START GOTO:', page.url());
    await assertNotCancelled(payload, page, 'after_start_goto');

    await navigateToLoginScreen(page, payload, timeout);
    await assertNotCancelled(payload, page, 'after_login_navigation');

    const { usernameSelector, passwordSelector } = await waitForLoginForm(page, payload, timeout);
    await assertNotCancelled(payload, page, 'before_credentials');

    await withCancellation(page.locator(usernameSelector).first().fill(payload.username, { timeout }), payload, page, 'fill_username');
    await withCancellation(page.locator(passwordSelector).first().fill(payload.password, { timeout }), payload, page, 'fill_password');

    await withCancellation(Promise.allSettled([
      page.locator(submitSelector).first().click({ timeout }),
      page.waitForLoadState('networkidle', { timeout }),
    ]), payload, page, 'submit_credentials');

    await sleepWithCancel(1500, payload, page, 'after_password_submit');

    let currentUrl = page.url();
    let hasPasswordField = await page.locator(passwordSelector).first().isVisible({ timeout: 2500 }).catch(() => false);

    if (currentUrl.includes('/Login/nl/Login/SMS')) {
      const mfaResult = {
        success: false,
        mfa_required: true,
        status: 'mfa_required',
        message: 'SMS-code vereist. Vul de SMS-code in GRANTLY in; de GitHub Actions sessie blijft tijdelijk open.',
        current_url: currentUrl,
        stopped_after: 'sms_mfa',
        provider_id: payload.provider_id || null,
        session_id: String(payload.provider_id || ''),
      };

      await postCallback(payload, mfaResult);

      if (typeof payload.on_mfa_required === 'function') {
        await payload.on_mfa_required(mfaResult);
      }

      const smsResult = await completeSmsMfa(page, payload, timeout);
      if (smsResult) {
        return smsResult;
      }

      currentUrl = page.url();
      hasPasswordField = await page.locator(passwordSelector).first().isVisible({ timeout: 2500 }).catch(() => false);
    }

    const successUrlMatches = payload.success_url_contains
      ? currentUrl.includes(payload.success_url_contains)
      : false;

    if (successUrlMatches || !hasPasswordField) {
      return {
        success: true,
        status: 'success',
        message: 'Z-login test succesvol: credentials en SMS-flow zijn afgerond.',
        current_url: currentUrl,
        stopped_after: 'login',
      };
    }

    return {
      success: false,
      status: 'failed',
      message: 'Login is niet aantoonbaar gelukt; wachtwoordveld staat nog zichtbaar of success URL matcht niet.',
      current_url: currentUrl,
      stopped_after: 'login_attempt',
    };
  } catch (error) {
    if (error instanceof ChainauthCancelledError) {
      return {
        success: false,
        status: 'cancelled',
        cancelled: true,
        message: error.message,
        current_url: error.currentUrl || page.url(),
        stopped_after: error.stoppedAfter || 'cancelled',
      };
    }

    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('zlogin_login.mjs') && process.env.CHAINAUTH_TEST_PAYLOAD) {
  const payload = JSON.parse(process.env.CHAINAUTH_TEST_PAYLOAD);
  runZloginLoginTest(payload)
    .then(async (result) => {
      await postCallback(payload, {
        status: result.status || (result.success ? 'success' : (result.cancelled ? 'cancelled' : 'failed')),
        success: !!result.success,
        mfa_required: !!result.mfa_required,
        message: result.message || '',
        current_url: result.current_url || '',
        stopped_after: result.stopped_after || '',
      });

      console.log(JSON.stringify(result));
      process.exit(result.success ? 0 : 1);
    })
    .catch(async (error) => {
      const payload = JSON.parse(process.env.CHAINAUTH_TEST_PAYLOAD || '{}');
      await postCallback(payload, {
        status: 'failed',
        success: false,
        message: error.message || String(error),
        stopped_after: 'worker_exception',
      });

      console.error(error);
      process.exit(1);
    });
}
