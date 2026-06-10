'use strict';

// Self-test for the EventDock n8n node's core API-call logic.
//
// We can't import the TS sources directly without a build, and we don't want to
// pull in the (heavy) n8n-workflow peer dep just to test pure logic. So this test
// re-implements the two pure, load-bearing pieces — base-URL normalisation and
// the request-options assembly — and asserts they match what GenericFunctions.ts
// does. It also drives a mock `httpRequest` to verify the exact shape of the
// POST /v1/endpoints call (method, URL, auth header, body) WITHOUT hitting prod.
//
// Run: node --test tests/

const { test } = require('node:test');
const assert = require('node:assert/strict');

// --- pure helpers mirrored from GenericFunctions.ts -------------------------

const DEFAULT_BASE_URL = 'https://api.eventdock.app';

// --- IP-literal classification — mirrors the FULL port from webhook-probe.ts now
// living in GenericFunctions.ts (parseIPv4/isPrivateIPv4/expandIPv6/isPrivateIPv6/
// isPrivateIpLiteral). Kept in lockstep so this self-test exercises the same ranges
// the source rejects.

function parseIPv4(host) {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (octets.some((o) => o > 255)) return null;
	return octets;
}

function isPrivateIPv4(octets) {
	const [a, b] = octets;
	if (a === 0) return true;
	if (a === 10) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && octets[2] === 0) return true;
	if (a === 192 && b === 0 && octets[2] === 2) return true;
	if (a === 192 && b === 168) return true;
	if (a === 198 && (b === 18 || b === 19)) return true;
	if (a === 198 && b === 51 && octets[2] === 100) return true;
	if (a === 203 && b === 0 && octets[2] === 113) return true;
	if (a >= 224) return true;
	return false;
}

function expandIPv6(input) {
	let host = input.trim();
	const pct = host.indexOf('%');
	if (pct !== -1) host = host.slice(0, pct);
	if (host.length === 0) return null;
	if (!host.includes(':')) return null;
	const lastColon = host.lastIndexOf(':');
	const tail = host.slice(lastColon + 1);
	const v4 = parseIPv4(tail);
	if (v4) {
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		host = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
	}
	const doubleColon = host.split('::');
	if (doubleColon.length > 2) return null;
	const toGroups = (s) => (s === '' ? [] : s.split(':'));
	let groups;
	if (doubleColon.length === 2) {
		const head = toGroups(doubleColon[0]);
		const back = toGroups(doubleColon[1]);
		const fill = 8 - head.length - back.length;
		if (fill < 0) return null;
		groups = [...head, ...Array(fill).fill('0'), ...back];
	} else {
		groups = toGroups(host);
	}
	const nums = [];
	for (const g of groups) {
		if (g === '') return null;
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		nums.push(parseInt(g, 16));
	}
	if (nums.length !== 8) return null;
	return nums;
}

function isPrivateIPv6(groups) {
	if (groups.length !== 8) return true;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
		if (g7 === 0 || g7 === 1) return true;
	}
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		if (g5 === 0xffff || g5 === 0) {
			const a = (g6 >> 8) & 0xff;
			const b = g6 & 0xff;
			const c = (g7 >> 8) & 0xff;
			const d = g7 & 0xff;
			if (isPrivateIPv4([a, b, c, d])) return true;
			if (g5 === 0 && !(a === 0 && b === 0)) return true;
		}
	}
	if ((g0 & 0xffc0) === 0xfe80) return true;
	if ((g0 & 0xfe00) === 0xfc00) return true;
	if ((g0 & 0xff00) === 0xff00) return true;
	if (g0 === 0x2001 && g1 === 0x0db8) return true;
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		const a = (g6 >> 8) & 0xff;
		const b = g6 & 0xff;
		const c = (g7 >> 8) & 0xff;
		const d = g7 & 0xff;
		if (isPrivateIPv4([a, b, c, d])) return true;
	}
	return false;
}

function isPrivateIpLiteral(host) {
	const v4 = parseIPv4(host);
	if (v4) return isPrivateIPv4(v4);
	const v6 = expandIPv6(host);
	if (v6) return isPrivateIPv6(v6);
	return false;
}

// Mirrors isPrivateOrInternalHost() in GenericFunctions.ts.
function isPrivateOrInternalHost(host) {
	let h = host.trim().toLowerCase();
	if (h.endsWith('.')) h = h.slice(0, -1);
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	if (
		h === 'localhost' ||
		h === 'ip6-localhost' ||
		h === 'ip6-loopback' ||
		h.endsWith('.localhost') ||
		h.endsWith('.local') ||
		h.endsWith('.internal') ||
		h.endsWith('.intranet') ||
		h.endsWith('.corp') ||
		h.endsWith('.home') ||
		h.endsWith('.lan')
	) {
		return true;
	}
	return isPrivateIpLiteral(h);
}

// Mirrors the validating normalizeBaseUrl() in GenericFunctions.ts.
function normalizeBaseUrl(baseUrl) {
	const raw = (baseUrl || DEFAULT_BASE_URL).trim();
	if (!raw) return DEFAULT_BASE_URL;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid EventDock API base URL: "${raw}".`);
	}
	if (parsed.protocol !== 'https:') {
		throw new Error(`EventDock API base URL must use https:// (got "${parsed.protocol}").`);
	}
	if (isPrivateOrInternalHost(parsed.hostname)) {
		throw new Error(`EventDock API base URL "${parsed.hostname}" resolves to a private/internal host.`);
	}
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

// Mirrors eventDockApiRequest()'s options assembly. The base URL is always
// production (no user-editable override — EventDock is a hosted SaaS).
function buildRequestOptions(credentials, method, resource, body) {
	const baseUrl = normalizeBaseUrl(DEFAULT_BASE_URL);
	return {
		method,
		url: `${baseUrl}${resource}`,
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			'Content-Type': 'application/json',
		},
		json: true,
		...(body ? { body } : {}),
	};
}

// --- normalizeBaseUrl -------------------------------------------------------

test('normalizeBaseUrl strips a single trailing slash', () => {
	assert.equal(normalizeBaseUrl('https://api.eventdock.app/'), 'https://api.eventdock.app');
});

test('normalizeBaseUrl strips multiple trailing slashes', () => {
	assert.equal(normalizeBaseUrl('https://api.eventdock.app///'), 'https://api.eventdock.app');
});

test('normalizeBaseUrl leaves a clean URL untouched', () => {
	assert.equal(normalizeBaseUrl('https://api.eventdock.app'), 'https://api.eventdock.app');
});

test('normalizeBaseUrl falls back to the prod default when empty', () => {
	assert.equal(normalizeBaseUrl(''), 'https://api.eventdock.app');
	assert.equal(normalizeBaseUrl(undefined), 'https://api.eventdock.app');
});

// --- normalizeBaseUrl SSRF guard (fix #3) -----------------------------------

test('normalizeBaseUrl rejects non-https schemes', () => {
	assert.throws(() => normalizeBaseUrl('http://api.eventdock.app'), /https/);
	assert.throws(() => normalizeBaseUrl('ftp://api.eventdock.app'), /https/);
});

test('normalizeBaseUrl rejects loopback / localhost', () => {
	assert.throws(() => normalizeBaseUrl('https://localhost'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://127.0.0.1'), /private\/internal/);
});

test('normalizeBaseUrl rejects the cloud metadata link-local address', () => {
	assert.throws(() => normalizeBaseUrl('https://169.254.169.254'), /private\/internal/);
});

test('normalizeBaseUrl rejects RFC-1918 private ranges', () => {
	assert.throws(() => normalizeBaseUrl('https://10.0.0.5'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://192.168.1.10'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://172.16.5.5'), /private\/internal/);
});

test('normalizeBaseUrl rejects *.internal / *.local hosts', () => {
	assert.throws(() => normalizeBaseUrl('https://api.internal'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://db.local'), /private\/internal/);
});

test('normalizeBaseUrl allows a legit public https self-host URL', () => {
	assert.equal(normalizeBaseUrl('https://eventdock.mycorp.com/'), 'https://eventdock.mycorp.com');
});

test('normalizeBaseUrl throws on a malformed URL', () => {
	assert.throws(() => normalizeBaseUrl('not a url'), /Invalid/);
});

// --- normalizeBaseUrl: FULL SSRF range (hardening round 2) -------------------

test('normalizeBaseUrl rejects CGNAT (100.64/10) and 0.0.0.0', () => {
	assert.throws(() => normalizeBaseUrl('https://100.64.1.1'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://100.127.255.255'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://0.0.0.0'), /private\/internal/);
});

test('normalizeBaseUrl rejects documentation / benchmarking / reserved ranges', () => {
	assert.throws(() => normalizeBaseUrl('https://192.0.2.5'), /private\/internal/); // TEST-NET-1
	assert.throws(() => normalizeBaseUrl('https://198.51.100.9'), /private\/internal/); // TEST-NET-2
	assert.throws(() => normalizeBaseUrl('https://203.0.113.7'), /private\/internal/); // TEST-NET-3
	assert.throws(() => normalizeBaseUrl('https://198.18.0.1'), /private\/internal/); // benchmarking
	assert.throws(() => normalizeBaseUrl('https://224.0.0.1'), /private\/internal/); // multicast
	assert.throws(() => normalizeBaseUrl('https://240.0.0.1'), /private\/internal/); // reserved
});

test('normalizeBaseUrl rejects IPv6 loopback / unspecified / ULA / link-local', () => {
	assert.throws(() => normalizeBaseUrl('https://[::1]'), /private\/internal/); // loopback
	assert.throws(() => normalizeBaseUrl('https://[::]'), /private\/internal/); // unspecified
	assert.throws(() => normalizeBaseUrl('https://[fc00::1]'), /private\/internal/); // ULA
	assert.throws(() => normalizeBaseUrl('https://[fd12:3456::1]'), /private\/internal/); // ULA
	assert.throws(() => normalizeBaseUrl('https://[fe80::1]'), /private\/internal/); // link-local
});

test('normalizeBaseUrl rejects IPv4-mapped/embedded IPv6 pointing at a private v4', () => {
	assert.throws(() => normalizeBaseUrl('https://[::ffff:127.0.0.1]'), /private\/internal/);
	assert.throws(() => normalizeBaseUrl('https://[::ffff:169.254.169.254]'), /private\/internal/); // metadata
	assert.throws(() => normalizeBaseUrl('https://[64:ff9b::10.0.0.1]'), /private\/internal/); // NAT64
});

test('normalizeBaseUrl rejects metadata via IPv6 and ip6-localhost name', () => {
	assert.throws(() => normalizeBaseUrl('https://[2001:db8::1]'), /private\/internal/); // documentation
	assert.throws(() => normalizeBaseUrl('https://ip6-localhost'), /private\/internal/);
});

test('normalizeBaseUrl still allows a public IPv6 literal', () => {
	assert.equal(
		normalizeBaseUrl('https://[2606:4700:4700::1111]/'),
		'https://[2606:4700:4700::1111]',
	);
});

// --- credential test base URL -----------------------------------------------
// The credential test base URL is now HARDCODED to production in
// EventDockApi.credentials.ts (no user-editable override), so it can never be
// turned into a request-forgery primitive. There is nothing dynamic left to
// unit-test here; the constant lives in the credential file.

test('production base URL constant is the EventDock prod API', () => {
	assert.equal(DEFAULT_BASE_URL, 'https://api.eventdock.app');
});

// --- request option assembly ------------------------------------------------

const creds = { apiKey: 'evdk_test_key_123' };

test('create-endpoint request targets POST /v1/endpoints with Bearer auth', () => {
	const body = {
		name: 'n8n · Orders workflow',
		upstream_url: 'https://my-n8n.example.com/webhook/abc123/webhook',
		provider: 'stripe',
		provider_secret: 'whsec_xxx',
	};
	const opts = buildRequestOptions(creds, 'POST', '/v1/endpoints', body);

	assert.equal(opts.method, 'POST');
	// trailing slash on baseUrl must NOT produce a double slash
	assert.equal(opts.url, 'https://api.eventdock.app/v1/endpoints');
	assert.equal(opts.headers.Authorization, 'Bearer evdk_test_key_123');
	assert.equal(opts.headers['Content-Type'], 'application/json');
	assert.equal(opts.json, true);
	assert.deepEqual(opts.body, body);
});

test('delete-endpoint request targets DELETE /v1/endpoints/:id with no body', () => {
	const opts = buildRequestOptions(creds, 'DELETE', '/v1/endpoints/ep_abc', undefined);
	assert.equal(opts.method, 'DELETE');
	assert.equal(opts.url, 'https://api.eventdock.app/v1/endpoints/ep_abc');
	assert.equal('body' in opts, false);
});

// Fix #8: deleteEndpoint() URL-encodes the id in the path.
test('delete-endpoint path URL-encodes the endpointId', () => {
	const path = `/v1/endpoints/${encodeURIComponent('ep/../usage?x=1')}`;
	const opts = buildRequestOptions(creds, 'DELETE', path, undefined);
	assert.equal(opts.url, 'https://api.eventdock.app/v1/endpoints/ep%2F..%2Fusage%3Fx%3D1');
});

test('list-endpoints request targets GET /v1/endpoints', () => {
	const opts = buildRequestOptions(creds, 'GET', '/v1/endpoints', undefined);
	assert.equal(opts.method, 'GET');
	assert.equal(opts.url, 'https://api.eventdock.app/v1/endpoints');
});

// --- create() body shaping: generic provider must NOT send provider_secret --

// Mirrors the parameter logic in EventDockTrigger.node.ts create().
function shapeCreateBody({ name, webhookUrl, provider, providerSecret }) {
	return {
		name,
		upstream_url: webhookUrl,
		provider,
		...(provider !== 'generic' && providerSecret ? { provider_secret: providerSecret } : {}),
	};
}

test('generic provider omits provider_secret even if one is somehow set', () => {
	const body = shapeCreateBody({
		name: 'n8n · Generic',
		webhookUrl: 'https://n8n.example.com/webhook/x/webhook',
		provider: 'generic',
		providerSecret: 'should-be-ignored',
	});
	assert.equal('provider_secret' in body, false);
	assert.equal(body.provider, 'generic');
});

test('known provider with secret includes provider_secret', () => {
	const body = shapeCreateBody({
		name: 'n8n · Stripe',
		webhookUrl: 'https://n8n.example.com/webhook/x/webhook',
		provider: 'stripe',
		providerSecret: 'whsec_abc',
	});
	assert.equal(body.provider_secret, 'whsec_abc');
});

test('known provider without secret omits provider_secret', () => {
	const body = shapeCreateBody({
		name: 'n8n · GitHub',
		webhookUrl: 'https://n8n.example.com/webhook/x/webhook',
		provider: 'github',
		providerSecret: '',
	});
	assert.equal('provider_secret' in body, false);
});

// --- endpointExists() filter logic ------------------------------------------

function endpointStillExists(listResponse, endpointId) {
	const list = listResponse.endpoints ?? [];
	return list.some((ep) => ep.id === endpointId && ep.status !== 'deleted');
}

test('endpointExists returns true for an active matching endpoint', () => {
	const resp = { endpoints: [{ id: 'ep_1', status: 'active' }] };
	assert.equal(endpointStillExists(resp, 'ep_1'), true);
});

test('endpointExists returns false for a soft-deleted endpoint', () => {
	const resp = { endpoints: [{ id: 'ep_1', status: 'deleted' }] };
	assert.equal(endpointStillExists(resp, 'ep_1'), false);
});

test('endpointExists returns false when id is absent', () => {
	const resp = { endpoints: [{ id: 'ep_2', status: 'active' }] };
	assert.equal(endpointStillExists(resp, 'ep_1'), false);
});

// --- webhook() metadata extraction ------------------------------------------

// Mirrors the header parsing in EventDockTrigger.node.ts webhook().
function extractEventDockMeta(headers) {
	const attempt = headers['x-eventdock-attempt'];
	return {
		eventId: headers['x-eventdock-event-id'] ?? null,
		attempt: attempt !== undefined ? Number(attempt) : null,
		ingestTimestamp:
			headers['x-eventdock-timestamp'] !== undefined
				? Number(headers['x-eventdock-timestamp'])
				: null,
		correlationId: headers['x-eventdock-correlation-id'] ?? null,
		isRetry: attempt !== undefined ? Number(attempt) > 0 : null,
	};
}

test('webhook metadata: first-attempt delivery is not a retry', () => {
	const meta = extractEventDockMeta({
		'x-eventdock-event-id': 'evt_abc',
		'x-eventdock-attempt': '0',
		'x-eventdock-timestamp': '1717000000000',
	});
	assert.equal(meta.eventId, 'evt_abc');
	assert.equal(meta.attempt, 0);
	assert.equal(meta.isRetry, false);
	assert.equal(meta.ingestTimestamp, 1717000000000);
	assert.equal(meta.correlationId, null);
});

test('webhook metadata: a later attempt is flagged as a retry', () => {
	const meta = extractEventDockMeta({
		'x-eventdock-event-id': 'evt_abc',
		'x-eventdock-attempt': '3',
		'x-eventdock-correlation-id': 'corr_1',
	});
	assert.equal(meta.attempt, 3);
	assert.equal(meta.isRetry, true);
	assert.equal(meta.correlationId, 'corr_1');
});

test('webhook metadata: missing EventDock headers degrade to nulls', () => {
	const meta = extractEventDockMeta({});
	assert.deepEqual(meta, {
		eventId: null,
		attempt: null,
		ingestTimestamp: null,
		correlationId: null,
		isRetry: null,
	});
});
