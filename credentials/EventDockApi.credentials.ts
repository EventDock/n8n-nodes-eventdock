import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class EventDockApi implements ICredentialType {
	name = 'eventDockApi';

	displayName = 'EventDock API';

	documentationUrl = 'https://eventdock.app/docs';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Your EventDock API key (starts with "evdk_"). Create one in the EventDock dashboard under Settings → API Keys. Free tier includes 5,000 events/month — sign up at https://eventdock.app.',
			placeholder: 'evdk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
		},
	];

	// Sends the API key as a Bearer token on every request the node makes.
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// n8n calls this when the user clicks "Test" on the credential.
	// GET /v1/usage is a cheap, read-only, side-effect-free endpoint that
	// returns 200 for a valid key and 401 for an invalid one.
	//
	// The base URL is HARDCODED to the EventDock production API. There is no
	// user-editable base URL, so the credential test can never be turned into a
	// request-forgery primitive (e.g. pointed at http://169.254.169.254 to read
	// the response/error on a multi-user n8n instance). EventDock is a hosted SaaS
	// — there is no self-hosted instance for a user to point this at.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.eventdock.app',
			url: '/v1/usage',
			method: 'GET',
		},
	};
}
