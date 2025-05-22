import { Postmarks, type Link } from './objects/postmarks';
export { Postmarks };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Not Found', { status: 404 });
		}

		const message = (await request.json()) as Record<string, string>;
		const { To, From, Subject, TextBody } = message;

		// This creates a new Durable Object instance for the user’s email address
		const id = env.POSTMARKS.idFromName(From as string);
		const postmarks = env.POSTMARKS.get(id);

		const subject = Subject.toLowerCase();

		if (subject.startsWith('add')) {
			const body = TextBody.trim();
			const link = await postmarks.addLink(From, body);
			ctx.waitUntil(
				sendEmail(env, {
					to: From as string,
					subject: 'New link added',
					links: [link],
				})
			);
		} else if (subject.startsWith('list')) {
			const links = await postmarks.getLinks();
			ctx.waitUntil(
				sendEmail(env, {
					to: From as string,
					subject: 'Your links',
					links,
				})
			);
		}

		return new Response(null, {
			status: 204,
		});
	},
} satisfies ExportedHandler<Env>;

async function sendEmail(env: Env, { to, subject, links }: { to: string; subject: string; links: Link[] }) {
	const response = await fetch('https://api.postmarkapp.com/email', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
		},
		body: JSON.stringify({
			To: to,
			From: env.FROM_EMAIL,
			Subject: subject,
			TextBody: links.map((link) => `${link.url} - Added ${link.created_at}`).join('\n'),
			HtmlBody: links.map((link) => `<a href="${link.url}">${link.url}</a> - Added ${link.created_at}`).join('<br />'),
		}),
	});

	if (!response.ok) {
		console.error(`Failed to send email: ${response.statusText}`);
	} else {
		return response;
	}
}
