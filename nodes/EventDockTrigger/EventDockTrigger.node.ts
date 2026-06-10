import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	createEndpoint,
	deleteEndpoint,
	endpointExists,
	type EventDockCredentials,
} from './GenericFunctions';

/**
 * EventDock Trigger
 * -----------------
 * Registers this workflow's n8n webhook URL as the *upstream destination* of a
 * freshly-created EventDock endpoint. Your provider (Stripe / Shopify / GitHub /
 * Twilio / any generic source) points at the EventDock ingest URL. EventDock then
 * buffers, retries (exponential backoff, up to 7 attempts over ~hours), de-dupes,
 * and finally delivers each event reliably to this trigger.
 *
 * Lifecycle:
 *   - workflow activated  -> create()  -> POST  /v1/endpoints  (upstream_url = n8n webhook URL)
 *   - workflow executes   -> webhook() -> emit the delivered payload + EventDock metadata
 *   - workflow deactivated -> delete() -> DELETE /v1/endpoints/:id
 */
export class EventDockTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'EventDock Trigger',
		name: 'eventDockTrigger',
		icon: 'file:eventdock.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=Provider: {{$parameter["provider"]}}',
		description: 'Starts the workflow on a reliable, retried, de-duplicated webhook delivery from EventDock',
		defaults: {
			name: 'EventDock Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'eventDockApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'EventDock receives your raw provider webhooks, retries failures, holds dead letters in a DLQ, and forwards clean events here. When this workflow is active, an EventDock endpoint is created automatically pointing at this node. Point your provider at the ingest URL shown after activation.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Endpoint Name',
				name: 'endpointName',
				type: 'string',
				default: '',
				placeholder: 'My n8n Stripe webhooks',
				description:
					'A human-readable name for the EventDock endpoint that will be created. Defaults to the workflow name + node name if left blank.',
			},
			{
				displayName: 'Provider',
				name: 'provider',
				type: 'options',
				default: 'generic',
				description:
					'The webhook source. Pick a known provider to unlock EventDock signature verification and provider-aware de-duplication, or "Generic" for any other source.',
				options: [
					{ name: 'Generic (Any Source)', value: 'generic' },
					{ name: 'GitHub', value: 'github' },
					{ name: 'Shopify', value: 'shopify' },
					{ name: 'Stripe', value: 'stripe' },
					{ name: 'Twilio', value: 'twilio' },
				],
			},
			{
				displayName: 'Signing Secret',
				name: 'providerSecret',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description:
					'Optional. The provider signing secret (e.g. Stripe webhook secret). When set for a known provider, EventDock verifies each incoming signature before accepting and forwarding the event. Ignored for the Generic provider.',
				displayOptions: {
					hide: {
						provider: ['generic'],
					},
				},
			},
		],
	};

	// n8n calls these to manage the lifecycle of the external (EventDock) resource.
	webhookMethods = {
		default: {
			/**
			 * Returns true if the EventDock endpoint we previously created still exists.
			 * n8n uses this to decide whether create() needs to run on activation.
			 */
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const endpointId = webhookData.endpointId as string | undefined;
				if (!endpointId) {
					return false;
				}

				const credentials = (await this.getCredentials('eventDockApi')) as EventDockCredentials;
				return endpointExists.call(this, credentials, endpointId);
			},

			/**
			 * Creates an EventDock endpoint whose upstream destination is this workflow's
			 * n8n webhook URL. This is the core of the connector.
			 */
			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const credentials = (await this.getCredentials('eventDockApi')) as EventDockCredentials;

				const provider = this.getNodeParameter('provider', 'generic') as string;
				const providerSecret = this.getNodeParameter('providerSecret', '') as string;

				let name = this.getNodeParameter('endpointName', '') as string;
				if (!name) {
					const workflowName = this.getWorkflow().name ?? 'n8n workflow';
					name = `n8n · ${workflowName}`;
				}

				const endpoint = await createEndpoint.call(this, credentials, {
					name,
					upstream_url: webhookUrl,
					provider,
					...(provider !== 'generic' && providerSecret ? { provider_secret: providerSecret } : {}),
				});

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.endpointId = endpoint.id;
				webhookData.ingestUrl = endpoint.ingest_url;
				webhookData.provider = provider;

				return true;
			},

			/**
			 * Soft-deletes the EventDock endpoint when the workflow is deactivated or
			 * the node is removed, so we don't leak endpoints against the user's plan limit.
			 */
			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				const endpointId = webhookData.endpointId as string | undefined;
				if (!endpointId) {
					return true;
				}

				const credentials = (await this.getCredentials('eventDockApi')) as EventDockCredentials;
				await deleteEndpoint.call(this, credentials, endpointId);

				delete webhookData.endpointId;
				delete webhookData.ingestUrl;
				delete webhookData.provider;
				return true;
			},
		},
	};

	/**
	 * Runs every time EventDock delivers a (reliable) event to this workflow.
	 * The body is the original provider payload; EventDock metadata arrives as
	 * X-EventDock-* headers.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const headers = this.getHeaderData() as IDataObject;
		const body = this.getBodyData();

		const eventDockEventId = headers['x-eventdock-event-id'] as string | undefined;
		const attempt = headers['x-eventdock-attempt'] as string | undefined;
		const ingestTimestamp = headers['x-eventdock-timestamp'] as string | undefined;
		const correlationId = headers['x-eventdock-correlation-id'] as string | undefined;

		// Defensive: a misconfigured proxy could strip our metadata headers. The
		// event is still valid, but we surface a clear error only if the body is
		// entirely empty (almost always a misrouted request).
		if (body === undefined || body === null) {
			throw new NodeOperationError(this.getNode(), 'EventDock delivered an empty request body.');
		}

		const eventdock: IDataObject = {
			eventId: eventDockEventId ?? null,
			attempt: attempt !== undefined ? Number(attempt) : null,
			ingestTimestamp: ingestTimestamp !== undefined ? Number(ingestTimestamp) : null,
			correlationId: correlationId ?? null,
			isRetry: attempt !== undefined ? Number(attempt) > 0 : null,
			deliveredAt: new Date().toISOString(),
		};

		return {
			workflowData: [
				this.helpers.returnJsonArray([
					{
						body,
						headers,
						query: req.query as IDataObject,
						eventdock,
					},
				]),
			],
		};
	}
}
