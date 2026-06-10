import { URL } from 'node:url';

import type { IHookFunctions, IHttpRequestOptions } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export interface EventDockCredentials {
	apiKey: string;
}

export interface CreateEndpointBody {
	name: string;
	upstream_url: string;
	provider: string;
	provider_secret?: string;
}

export interface EventDockEndpoint {
	id: string;
	name: string;
	upstream_url: string;
	provider: string;
	status: string;
	ingest_url: string;
	created_at: string;
}

export const DEFAULT_BASE_URL = 'https://api.eventdock.app';

// ---------------------------------------------------------------------------
// SSRF IP-literal classification.
//
// Ported verbatim (logic-for-logic) from the EventDock backend's canonical
// validator: apps/worker/src/routes/webhook-probe.ts (parseIPv4 / isPrivateIPv4
// / expandIPv6 / isPrivateIPv6 / isPrivateIpLiteral). Keeping these in lock-step
// with the backend means the connector rejects exactly the same private /
// loopback / link-local / CGNAT / metadata / documentation / IPv6 ULA ranges the
// platform does — no partial, drifting subset.
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string into 4 octets, or null if not a valid IPv4. */
export function parseIPv4(host: string): [number, number, number, number] | null {
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	if (octets.some((o) => o > 255)) return null;
	return octets as [number, number, number, number];
}

/**
 * Returns true if the given IPv4 octets fall in a private, loopback,
 * link-local, reserved, or otherwise non-publicly-routable range.
 */
function isPrivateIPv4(octets: [number, number, number, number]): boolean {
	const [a, b] = octets;

	if (a === 0) return true; // 0.0.0.0/8 — "this network"
	if (a === 10) return true; // 10.0.0.0/8 — RFC1918 private
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT (RFC6598)
	if (a === 127) return true; // 127.0.0.0/8 — loopback
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (incl. metadata 169.254.169.254)
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC1918 private
	if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 — IETF protocol assignments
	if (a === 192 && b === 0 && octets[2] === 2) return true; // 192.0.2.0/24 — TEST-NET-1
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC1918 private
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmarking
	if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 — TEST-NET-2
	if (a === 203 && b === 0 && octets[2] === 113) return true; // 203.0.113.0/24 — TEST-NET-3
	if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast

	return false;
}

/**
 * Expand an IPv6 address (possibly with "::") into 8 16-bit groups, or null if
 * it cannot be parsed. Handles IPv4-mapped/embedded forms by converting the
 * trailing dotted-quad into two hextets.
 */
function expandIPv6(input: string): number[] | null {
	let host = input.trim();
	const pct = host.indexOf('%'); // strip zone id (fe80::1%eth0)
	if (pct !== -1) host = host.slice(0, pct);
	if (host.length === 0) return null;
	if (!host.includes(':')) return null;

	// Normalise an embedded IPv4 suffix (::ffff:127.0.0.1) into two hex groups.
	const lastColon = host.lastIndexOf(':');
	const tail = host.slice(lastColon + 1);
	const v4 = parseIPv4(tail);
	if (v4) {
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		host = `${host.slice(0, lastColon + 1)}${hi}:${lo}`;
	}

	const doubleColon = host.split('::');
	if (doubleColon.length > 2) return null; // more than one "::" is invalid

	const toGroups = (s: string): string[] => (s === '' ? [] : s.split(':'));

	let groups: string[];
	if (doubleColon.length === 2) {
		const head = toGroups(doubleColon[0]!);
		const back = toGroups(doubleColon[1]!);
		const fill = 8 - head.length - back.length;
		if (fill < 0) return null;
		groups = [...head, ...Array(fill).fill('0'), ...back];
	} else {
		groups = toGroups(host);
	}

	const nums: number[] = [];
	for (const g of groups) {
		if (g === '') return null;
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		nums.push(parseInt(g, 16));
	}
	if (nums.length !== 8) return null;
	return nums;
}

/**
 * Returns true if the given IPv6 address is loopback, link-local, unique-local,
 * unspecified, or an IPv4-mapped/embedded address that maps to a private IPv4.
 */
function isPrivateIPv6(groups: number[]): boolean {
	if (groups.length !== 8) return true; // fail closed

	const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
		number,
		number,
		number,
		number,
		number,
		number,
		number,
		number,
	];

	// :: (unspecified) and ::1 (loopback)
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) {
		if (g7 === 0 || g7 === 1) return true;
	}

	// IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
	if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
		if (g5 === 0xffff || g5 === 0) {
			const a = (g6 >> 8) & 0xff;
			const b = g6 & 0xff;
			const c = (g7 >> 8) & 0xff;
			const d = g7 & 0xff;
			if (isPrivateIPv4([a, b, c, d])) return true;
			if (g5 === 0 && !(a === 0 && b === 0)) return true; // deprecated ::a.b.c.d
		}
	}

	if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
	if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique local (fc00::/fd00::)
	if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 — multicast
	if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 — documentation

	// 64:ff9b::/96 NAT64 well-known prefix wraps an embedded IPv4.
	if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		const a = (g6 >> 8) & 0xff;
		const b = g6 & 0xff;
		const c = (g7 >> 8) & 0xff;
		const d = g7 & 0xff;
		if (isPrivateIPv4([a, b, c, d])) return true;
	}

	return false;
}

/**
 * Classify a string that may be an IP literal. Returns true if it is a
 * private/reserved literal (must be blocked). If it is not a recognisable IP
 * literal it returns false (a hostname — handled by the name-suffix checks).
 */
export function isPrivateIpLiteral(host: string): boolean {
	const v4 = parseIPv4(host);
	if (v4) return isPrivateIPv4(v4);
	const v6 = expandIPv6(host);
	if (v6) return isPrivateIPv6(v6);
	return false;
}

/**
 * Hostnames / IP literals that must never be used as the API base URL. In a
 * multi-user n8n instance an editable base URL is an SSRF primitive — a user
 * could point the node at the instance's own metadata service or other internal
 * hosts. We reject internal-looking names AND the full set of private/reserved
 * IP literals (the complete isPrivateIpLiteral set ported from the backend).
 *
 * DNS-REBINDING CAVEAT: this is a literal/name check only. A public hostname
 * that *resolves* to a private IP (DNS rebinding) is NOT caught here — a
 * declarative n8n credential cannot resolve DNS at validate time, and we
 * deliberately do not build a resolver into the credential. This residual is
 * accepted because (a) the base URL field is behind the Advanced toggle and
 * defaults to prod, and (b) the EventDock BACKEND is the authoritative SSRF
 * guard and re-resolves + re-validates every destination on its side.
 */
export function isPrivateOrInternalHost(host: string): boolean {
	// Strip IPv6 brackets and a trailing FQDN dot before classifying.
	let h = host.trim().toLowerCase();
	if (h.endsWith('.')) h = h.slice(0, -1);
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

	// Internal-looking hostnames regardless of DNS.
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

	// Full private/reserved IP-literal classification (IPv4 + IPv6), ported from
	// the backend so the connector blocks the exact same ranges.
	return isPrivateIpLiteral(h);
}

/**
 * Normalises and VALIDATES the base URL. Strips a trailing slash so we never
 * produce "https://api.eventdock.app//v1/endpoints", and — because the base URL
 * is user-editable (for self-host / staging) — enforces that it is an https URL
 * pointing at a public host. This is the SSRF guard for the connector: every
 * runtime API call flows through here, so a malicious or fat-fingered base URL
 * (e.g. http://169.254.169.254) is rejected before any request is made.
 */
export function normalizeBaseUrl(baseUrl: string): string {
	const raw = (baseUrl || DEFAULT_BASE_URL).trim();
	if (!raw) {
		return DEFAULT_BASE_URL;
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid EventDock API base URL: "${raw}". It must be a full https:// URL.`);
	}

	if (parsed.protocol !== 'https:') {
		throw new Error(
			`EventDock API base URL must use https:// (got "${parsed.protocol}"). Refusing to send credentials over an unencrypted or non-HTTP scheme.`,
		);
	}

	if (isPrivateOrInternalHost(parsed.hostname)) {
		throw new Error(
			`EventDock API base URL "${parsed.hostname}" resolves to a private/internal host, which is not allowed.`,
		);
	}

	// Re-serialise from the parsed origin + path and strip any trailing slash so
	// downstream string concatenation (`${baseUrl}${resource}`) stays clean.
	return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Low-level authenticated request against the EventDock API.
 * Centralises the Bearer auth + JSON handling + error surfacing so every
 * call site stays a one-liner and errors are reported consistently in n8n.
 */
export async function eventDockApiRequest(
	this: IHookFunctions,
	credentials: EventDockCredentials,
	method: IHttpRequestOptions['method'],
	resource: string,
	body?: object,
): Promise<unknown> {
	// EventDock is a hosted SaaS — the API base URL is always production; there is
	// no user-editable override, so there is no SSRF surface here. normalizeBaseUrl
	// is kept on the path as a validated, tested chokepoint (defense in depth).
	const baseUrl = normalizeBaseUrl(DEFAULT_BASE_URL);

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${resource}`,
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			'Content-Type': 'application/json',
		},
		json: true,
		...(body ? { body } : {}),
	};

	try {
		return await this.helpers.httpRequest(options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as never);
	}
}

/**
 * POST /v1/endpoints — create an EventDock endpoint whose upstream destination
 * is the n8n webhook URL. Returns the created endpoint (including its ingest_url).
 */
export async function createEndpoint(
	this: IHookFunctions,
	credentials: EventDockCredentials,
	body: CreateEndpointBody,
): Promise<EventDockEndpoint> {
	return (await eventDockApiRequest.call(
		this,
		credentials,
		'POST',
		'/v1/endpoints',
		body,
	)) as EventDockEndpoint;
}

/**
 * DELETE /v1/endpoints/:id — soft-delete the endpoint on workflow deactivation.
 */
export async function deleteEndpoint(
	this: IHookFunctions,
	credentials: EventDockCredentials,
	endpointId: string,
): Promise<void> {
	await eventDockApiRequest.call(
		this,
		credentials,
		'DELETE',
		`/v1/endpoints/${encodeURIComponent(endpointId)}`,
	);
}

/**
 * GET /v1/endpoints — used by checkExists() to confirm a previously-created
 * endpoint is still present (and not soft-deleted) before n8n decides whether
 * to re-create it on activation.
 */
export async function endpointExists(
	this: IHookFunctions,
	credentials: EventDockCredentials,
	endpointId: string,
): Promise<boolean> {
	const response = (await eventDockApiRequest.call(this, credentials, 'GET', '/v1/endpoints')) as {
		endpoints?: Array<{ id: string; status?: string }>;
	};

	const list = response.endpoints ?? [];
	return list.some((ep) => ep.id === endpointId && ep.status !== 'deleted');
}
