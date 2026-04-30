import { chromium } from 'playwright';

function coerceTimeout(payload) {
  const timeout = Number(payload.timeout_ms || 45000);
  return Math.max(5000, Math.min(120000, Number.isFinite(timeout) ? timeout : 45000));
}


async function pollForMfaCode(payload, timeout) {
  const pollUrl = payload.mfa_code_url;
  if (!pollUrl) {
    console.log('MFA polling disabled: missing mfa_code_url');
    return null;
  }

  const deadline = Date.now() + Number(payload.mfa_poll_timeout_ms || 480000);
  const interval = Math.max(1000, Number(payload.mfa_poll_interval_ms || 3000));

  while (Date.now() < deadline) {
    const url = new URL(pollUrl);
    url.searchParams.set('provider_id', String(payload.provider_id || ''));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${payload.callback_token || ''}`,
        'Accept': 'application/json',
      },
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));

    if (res.ok) {
      const data = await res.json().catch(() => null);
      if (data && data.success && data.code) {
        console.log('MFA code received from GRANTLY, continuing same browser session.');
        return String(data.code).trim();
      }
      console.log('MFA code pending...');
    } else {
      const text = await res.text().catch(() => '');
      console.log(`MFA poll status: ${res.status} ${text}`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return null;
}

async function completeSmsMfa(page, payload, timeout) {
  const smsCode = await pollForMfaCode(payload, timeout);

  if (!smsCode) {
    return {
      success: false,
      mfa_required: true,
      message: 'SMS-code vereist maar niet op tijd ontvangen in GRANTLY.',
      current_url: page.url(),
      stopped_after: 'sms_mfa_timeout',
    };
  }

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

  await page.locator(smsSelector).first().waitFor({ state: 'visible', timeout });
  await page.locator(smsSelector).first().fill(smsCode, { timeout });

  await Promise.allSettled([
    page.waitForLoadState('networkidle', { timeout }),
    page.locator(submitSelector).first().click({ timeout }),
  ]);

  await page.waitForTimeout(2000);
  return null;
}

async function navigateToLoginScreen(page, payload, timeout) {
  if (payload.login_url && payload.login_url !== payload.start_url) {
    await page.goto(payload.login_url, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    console.log('URL AFTER LOGIN_URL GOTO:', page.url());
    return;
  }

  if (payload.login_click_selector) {
    const link = page.locator(payload.login_click_selector).first();
    const href = await link.getAttribute('href').catch(() => null);

    if (href) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout });
    } else {
      await link.click({ timeout });
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
    }

    console.log('URL AFTER LOGIN CLICK:', page.url());
    return;
  }

  // Z-login homepage: eerst naar "Mijn Z login" / UsernamePassword scherm.
  const directLoginLink = page
    .locator('a[href*="/Login/nl/Login/UsernamePassword"], a[href*="login.zlogin.nl"][href*="UsernamePassword"]')
    .first();

  if (await directLoginLink.count()) {
    const href = await directLoginLink.getAttribute('href').catch(() => null);
    if (href) {
      await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout });
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
          await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout });
        } else {
          await item.click({ timeout: 5000 });
          await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
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
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
    console.log('URL AFTER START GOTO:', page.url());

    await navigateToLoginScreen(page, payload, timeout);

    const { usernameSelector, passwordSelector } = await waitForLoginForm(page, payload, timeout);

    await page.locator(usernameSelector).first().fill(payload.username, { timeout });
    await page.locator(passwordSelector).first().fill(payload.password, { timeout });

    await Promise.allSettled([
      page.waitForLoadState('networkidle', { timeout }),
      page.locator(submitSelector).first().click({ timeout }),
    ]);

    await page.waitForTimeout(1500);

    const currentUrl = page.url();
    const hasPasswordField = await page.locator(passwordSelector).first().isVisible({ timeout: 2500 }).catch(() => false);

    if (currentUrl.includes('/Login/nl/Login/SMS')) {
      const mfaResult = {
        success: false,
        mfa_required: true,
        message: 'SMS-code vereist. Vul de SMS-code in GRANTLY in; de GitHub Actions sessie blijft tijdelijk open.',
        current_url: currentUrl,
        stopped_after: 'sms_mfa',
        provider_id: payload.provider_id || null,
        session_id: String(payload.provider_id || ''),
      };

      if (typeof payload.on_mfa_required === 'function') {
        await payload.on_mfa_required(mfaResult);
      }

      const smsResult = await completeSmsMfa(page, payload, timeout);
      if (smsResult) {
        return smsResult;
      }
    }

    const successUrlMatches = payload.success_url_contains
      ? currentUrl.includes(payload.success_url_contains)
      : false;

    if (successUrlMatches || !hasPasswordField) {
      return {
        success: true,
        message: 'Z-login test succesvol: credentials ingevuld en login-flow is voorbij het wachtwoordscherm.',
        current_url: currentUrl,
        stopped_after: 'login',
      };
    }

    return {
      success: false,
      message: 'Login is niet aantoonbaar gelukt; wachtwoordveld staat nog zichtbaar of success URL matcht niet.',
      current_url: currentUrl,
      stopped_after: 'login_attempt',
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

if (process.argv[1] && process.argv[1].endsWith('zlogin_login.mjs') && process.env.CHAINAUTH_TEST_PAYLOAD) {
  const payload = JSON.parse(process.env.CHAINAUTH_TEST_PAYLOAD);
  runZloginLoginTest(payload)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
