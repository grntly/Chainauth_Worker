import { chromium } from 'playwright';

function coerceTimeout(payload) {
  const timeout = Number(payload.timeout_ms || 30000);
  return Math.max(5000, Math.min(120000, Number.isFinite(timeout) ? timeout : 30000));
}

async function clickOptionalLoginButton(page, payload, timeout) {
  if (payload.login_click_selector) {
    await page.locator(payload.login_click_selector).first().click({ timeout });
    return true;
  }

  const candidates = [
    page.getByRole('link', { name: /inloggen|login|sign in/i }),
    page.getByRole('button', { name: /inloggen|login|sign in/i }),
    page.locator('a[href*="login" i], button:has-text("Login"), button:has-text("Inloggen")').first(),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.first().isVisible({ timeout: 2500 })) {
        await locator.first().click({ timeout: 5000 });
        return true;
      }
    } catch (_) {
      // Candidate not present; continue.
    }
  }

  return false;
}

async function waitForLoginForm(page, payload, timeout) {
  const usernameSelector = payload.username_selector || 'input[type="email"], input[name="username"], input[name="Username"], input[id*="user" i]';
  const passwordSelector = payload.password_selector || 'input[type="password"]';

  await page.locator(usernameSelector).first().waitFor({ state: 'visible', timeout });
  await page.locator(passwordSelector).first().waitFor({ state: 'visible', timeout });

  return { usernameSelector, passwordSelector };
}

export async function runZloginLoginTest(payload) {
  const timeout = coerceTimeout(payload);
  const startUrl = payload.start_url || payload.login_url || 'https://zlogin.nl/';
  const submitSelector = payload.submit_selector || 'button[type="submit"], input[type="submit"]';

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

    // Optional: when start_url is a marketing page, click through to actual login.
    await clickOptionalLoginButton(page, payload, timeout).catch(() => false);

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
