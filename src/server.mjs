import express from 'express';
import { runZloginLoginTest } from './zlogin_login.mjs';

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
    const result = await runZloginLoginTest(payload);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message || 'Z-login test failed.',
    });
  }
});

app.listen(port, () => {
  console.log(`chainauth-worker listening on ${port}`);
});
