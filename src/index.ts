export { Postmarks } from './objects/postmarks';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Not Found', { status: 404 });
		}

		const message = await request.json();
		const { To, From, Subject } = message as Record<string, unknown>;

		ctx.waitUntil(
			fetch('https://api.postmarkapp.com/email', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
				},
				body: JSON.stringify({
					To: From as string,
					From: To as string,
					Subject: 'Message received',
					TextBody: JSON.stringify(message, null, 2),
					HtmlBody: `<pre>${JSON.stringify(message, null, 2)}</pre>`,
				}),
			})
		);

		return new Response(null, {
			status: 204,
		});
	},
} satisfies ExportedHandler<Env>;
