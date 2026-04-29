import express from 'express';
import crypto from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runZloginLoginTest } from './zlogin_login.mjs';


function loadDotEnvFile() {
  if (process.env.CHAINAUTH_SKIP_DOTENV === '1') {
    return;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, '..', '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFile();

const sessions = new Map();

const app = express();
app.use(express.json({ limit: '2mb' }));

const port = process.env.PORT || 8080;
const workerToken = process.env.WORKER_TOKEN || '';

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requireAuth(req, res, next) {
  if (workerToken && bearerToken(req) !== workerToken) {
    return res.status(401).json({ success: false, message: 'Unauthorized worker request.' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ success: true, service: 'chainauth-worker' });
});

app.post('/login/zlogin', requireAuth, async (req, res) => {
  const payload = req.body || {};

  if (!payload.username || !payload.password) {
    return res.status(400).json({ success: false, message: 'Missing username or password.' });
  }

  try {
    const result = await runZloginLoginTest({
      ...payload,
      keep_browser_open_on_mfa: true,
    });

    if (result.mfa_required) {
      const sessionId = crypto.randomUUID();

      sessions.set(sessionId, {
        browser: result.browser,
        context: result.context,
        page: result.page,
        created_at: Date.now(),
      });

      return res.json({
        success: false,
        mfa_required: true,
        session_id: sessionId,
        message: 'SMS-code vereist.',
        current_url: result.current_url,
      });
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Z-login test failed.',
    });
  }
});

app.post('/login/zlogin/mfa', requireAuth, async (req, res) => {
  try {
    const { session_id, code } = req.body || {};

    if (!session_id || !code) {
      return res.status(400).json({
        success: false,
        message: 'session_id en code zijn verplicht.',
      });
    }

    const session = sessions.get(session_id);

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'MFA sessie niet gevonden of verlopen.',
      });
    }

    const { page, context, browser } = session;

    const codeSelector =
      'input[name="Code"], input[name="SmsCode"], input[name="VerificationCode"], input[type="tel"], input[type="text"]';

    const submitSelector =
      'button.main-btn, button[type="submit"], input[type="submit"]';

    await page.locator(codeSelector).first().waitFor({
      state: 'visible',
      timeout: 30000,
    });

    await page.locator(codeSelector).first().fill(code);

    await Promise.allSettled([
      page.waitForLoadState('networkidle', { timeout: 30000 }),
      page.locator(submitSelector).first().click({ timeout: 30000 }),
    ]);

    await page.waitForTimeout(1500);

    const currentUrl = page.url();

    sessions.delete(session_id);

    await context.close();
    await browser.close();

    return res.json({
      success: true,
      message: 'MFA-code verwerkt.',
      current_url: currentUrl,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.listen(port, () => {
  console.log(`chainauth-worker listening on http://127.0.0.1:${port}`);
});