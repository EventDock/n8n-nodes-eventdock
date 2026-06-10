# n8n-nodes-eventdock

Make your n8n webhook triggers **reliable**. This community node turns
[EventDock](https://eventdock.app) into a webhook **source** for n8n: raw
provider webhooks hit EventDock first, where they are buffered, retried, and
de-duplicated, and only **clean, reliable events** are delivered into your
workflow.

> **EventDock** is a webhook reliability layer. It receives your incoming
> webhooks at a stable ingest URL, retries failed deliveries with exponential
> backoff (up to 7 attempts over several hours), de-duplicates repeats, parks
> permanent failures in a Dead Letter Queue, and forwards successful events to a
> destination you configure. **Free tier: 5,000 events/month** —
> [sign up](https://eventdock.app).

## Why use this instead of n8n's built-in Webhook node?

A plain n8n Webhook node receives the provider's request **once**. If your n8n
instance is briefly down, mid-deploy, rate-limited, or the execution errors, that
event is **gone** — most providers retry only a few times, then drop it.

Put EventDock in front and you get:

| | Plain Webhook node | EventDock Trigger |
|---|---|---|
| Retries on n8n downtime | ❌ (provider's limited retries only) | ✅ up to 7 attempts over hours |
| De-duplication of repeated deliveries | ❌ | ✅ |
| Dead Letter Queue for permanent failures | ❌ | ✅ |
| Signature verification (Stripe/Shopify/GitHub/Twilio) | manual | ✅ at the edge |
| Replay a missed event | ❌ | ✅ from the EventDock dashboard |

## How it works

When you **activate** a workflow containing the EventDock Trigger, the node
automatically calls the EventDock API and creates an endpoint whose **upstream
destination is this workflow's n8n webhook URL**:

```
Provider ──▶ EventDock ingest URL ──▶ (buffer · retry · de-dupe · DLQ) ──▶ n8n webhook URL ──▶ your workflow
```

1. Activate the workflow. The node creates an EventDock endpoint and logs/stores
   the **ingest URL** (e.g. `https://api.eventdock.app/in/<endpointId>`).
2. Configure that ingest URL in your provider (Stripe, Shopify, GitHub, Twilio,
   or any generic webhook source) instead of pointing it directly at n8n.
3. Every reliable delivery starts your workflow. The original payload is in
   `body`; EventDock metadata (event id, attempt number, whether it's a retry)
   is in `eventdock`.
4. Deactivate the workflow and the EventDock endpoint is cleaned up
   automatically.

### Output shape

```json
{
  "body":    { /* the original provider webhook payload */ },
  "headers": { /* original headers + X-EventDock-* */ },
  "query":   { /* query string params, if any */ },
  "eventdock": {
    "eventId": "V1StGXR8_Z5jdHi6B-myT",
    "attempt": 0,
    "ingestTimestamp": 1717000000000,
    "correlationId": null,
    "isRetry": false,
    "deliveredAt": "2026-06-09T12:00:00.000Z"
  }
}
```

## Installation

### On n8n Cloud / self-hosted (verified community node)

Once published and verified, install from **Settings → Community Nodes** and
search for `n8n-nodes-eventdock`.

### Manual (self-hosted, before publish)

```bash
# in your n8n custom extensions directory (~/.n8n/custom or N8N_CUSTOM_EXTENSIONS)
npm install n8n-nodes-eventdock
```

## Credentials

Create an **EventDock API** credential:

- **API Key** — from the EventDock dashboard → Settings → API Keys (starts with
  `evdk_`). [Get one free](https://eventdock.app).
- **API Base URL** — defaults to `https://api.eventdock.app`. Only change for a
  self-hosted/staging EventDock.

Click **Test** to verify the key (it calls the read-only `GET /v1/usage`).

## Node: EventDock Trigger

| Parameter | Description |
|---|---|
| **Endpoint Name** | Optional. Defaults to `n8n · <workflow name>`. |
| **Provider** | `generic` (any source), or `stripe` / `shopify` / `github` / `twilio` to unlock edge signature verification and provider-aware de-dup. |
| **Signing Secret** | Optional. For a known provider, EventDock verifies each signature before accepting & forwarding (rejects forgeries at the edge). |

---

## Development

```bash
npm install
npm run build        # tsc + copy icons into dist/
npm run lint         # eslint-plugin-n8n-nodes-base checks
npm test             # offline unit tests of the API helpers (node --test)
```

The unit tests (`tests/`) exercise the core API-call logic — base-URL handling,
the `POST /v1/endpoints` request shape, generic-vs-known provider body shaping,
and the `X-EventDock-*` metadata parsing — without hitting the network.

## Publishing (verified community node)

> n8n requires **verified** community nodes to be published to npm via a GitHub
> Actions workflow **with provenance**. The workflow is already included at
> [`.github/workflows/publish.yml`](.github/workflows/publish.yml). **These steps
> are intentionally NOT run automatically — they publish under the maintainer's
> npm/GitHub identity and must be done by a human.**

1. Push this package to a GitHub repo named `n8n-nodes-eventdock` under the
   `eventdock` org (update `repository` in `package.json` if the name differs).
2. On **npmjs.com → the package's Settings → Publish access → Trusted
   Publishers → Add a publisher**, select **GitHub Actions** and enter:
   - repository owner: `eventdock`
   - repository name: `n8n-nodes-eventdock`
   - workflow name: `publish.yml`

   (Trusted Publishers uses OIDC, so **no `NPM_TOKEN` secret is needed**.)
3. Bump the version and tag a release:
   ```bash
   npm version 0.1.0
   git push --follow-tags
   ```
   The `publish.yml` workflow runs on the `v*` tag and executes
   `npm publish --provenance --access public` with `id-token: write` permission.
4. Submit the package for verification through the **n8n Creator Portal**. n8n
   fetches the provenance-signed package from npm for final vetting.

### Verified-node constraints already satisfied

- Package name starts with `n8n-nodes-`.
- `package.json` includes the `n8n-community-node-package` keyword and an `n8n`
  attribute listing the credential and node.
- **No runtime dependencies** (`n8n-workflow` is a peer/dev dependency only) —
  verified nodes may not ship runtime deps.

## License

[MIT](LICENSE)
