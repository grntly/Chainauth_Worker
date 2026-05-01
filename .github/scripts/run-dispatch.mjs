import { runZloginLoginTest } from '../../src/zlogin_login.mjs';

const callbackUrl = process.env.CALLBACK_URL;
const callbackToken = process.env.CALLBACK_TOKEN;
const providerId = process.env.PROVIDER_ID;

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

required('CALLBACK_URL', callbackUrl);
required('CALLBACK_TOKEN', callbackToken);
required('PROVIDER_ID', providerId);
required('USERNAME', process.env.USERNAME);
required('PASSWORD', process.env.PASSWORD);

async function postCallback(payload) {
  console.log('Posting callback:', JSON.stringify(payload));

  const res = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${callbackToken}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log('Callback status:', res.status);
  console.log('Callback response:', text);

  if (!res.ok) {
    throw new Error(`Callback failed: ${res.status} ${text}`);
  }
}

function optional(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

async function main() {
  await postCallback({
    provider_id: Number(providerId),
    status: 'running',
    message: 'GitHub Actions ChainAuth login gestart.',
  });

  const payload = {
    provider_id: Number(providerId),
    callback_token: callbackToken,
    start_url: optional('START_URL') || optional('LOGIN_URL') || 'https://zlogin.nl/',
    login_url: optional('LOGIN_URL'),
    username: process.env.USERNAME,
    password: process.env.PASSWORD,
    login_click_selector: optional('LOGIN_CLICK_SELECTOR'),
    username_selector: optional('USERNAME_SELECTOR'),
    password_selector: optional('PASSWORD_SELECTOR'),
    submit_selector: optional('SUBMIT_SELECTOR'),
    success_url_contains: optional('SUCCESS_URL_CONTAINS'),
    timeout_ms: optional('TIMEOUT_MS') || '30000',
    mfa_code_url: optional('MFA_CODE_URL') || (callbackUrl.endsWith('/callback') ? callbackUrl.replace(/\/callback$/, '/mfa-code') : undefined),
    mfa_poll_timeout_ms: optional('MFA_POLL_TIMEOUT_MS') || '600000',
    mfa_poll_interval_ms: optional('MFA_POLL_INTERVAL_MS') || '3000',
    sms_selector: optional('SMS_SELECTOR'),
    sms_submit_selector: optional('SMS_SUBMIT_SELECTOR'),
    user_agent: optional('USER_AGENT') || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Grantly ChainAuth GitHub Runner/1.0',
    keep_browser_open_on_mfa: false,
  };

  console.log('MFA_CODE_URL:', payload.mfa_code_url || '(missing)');
  console.log('MFA_POLL_TIMEOUT_MS:', payload.mfa_poll_timeout_ms);

  payload.on_mfa_required = async (mfaResult) => {
    await postCallback({
      provider_id: Number(providerId),
      status: 'mfa_required',
      message: mfaResult.message || 'SMS-code vereist.',
      session_id: String(providerId),
      result: mfaResult,
    });
  };

  const result = await runZloginLoginTest(payload).catch((error) => ({
    success: false,
    message: error.message || String(error),
  }));

  await postCallback({
    provider_id: Number(providerId),
    status: result.success ? 'success' : (result.cancelled ? 'stopped' : (result.mfa_required ? 'mfa_required' : 'failed')),
    message: result.message || (result.success ? 'Login succesvol.' : 'Login mislukt.'),
    result,
  });

  if (!result.success) {
    process.exitCode = (result.mfa_required || result.cancelled) ? 0 : 1;
  }
}

main().catch(async (err) => {
  console.error('run-dispatch failed:', err);
  try {
    await postCallback({
      provider_id: Number(providerId || 0),
      status: 'failed',
      message: err.message || String(err),
    });
  } catch (callbackErr) {
    console.error('error callback failed:', callbackErr);
  }
  process.exit(1);
});
