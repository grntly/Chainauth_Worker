# ChainAuth Worker

Playwright/Chromium worker voor GRANTLY ketenmachtiging headless login-tests.

## Lokaal draaien

```bash
docker build -t chainauth-worker .
docker run --rm -p 8080:8080 -e WORKER_TOKEN=change-me chainauth-worker
```

Healthcheck:

```bash
curl http://127.0.0.1:8080/health
```

Login-test:

```bash
curl -X POST http://127.0.0.1:8080/login/zlogin \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer change-me' \
  -d '{
    "username": "demo",
    "password": "secret",
    "start_url": "https://zlogin.nl/",
    "timeout_ms": 30000
  }'
```

## GRANTLY instellingen

Vul in de module settings:

- Worker URL: `http://host.docker.internal:8080` of je publieke Cloud Run/Kubernetes URL
- Worker token: dezelfde waarde als `WORKER_TOKEN`
