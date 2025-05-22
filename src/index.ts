import { Postmarks } from './objects/postmarks';
import { LinksWorkflow } from './workflows/links';
import { sendEmail } from './services/send-email';

export { Postmarks, LinksWorkflow };

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
			await env.WORKFLOW.create({ params: { email: From as string, url: body } });
		} else if (subject.startsWith('list')) {
			const links = await postmarks.getLinks();
			ctx.waitUntil(
				sendEmail(env, {
					to: From as string,
					subject: 'Your links',
					text: links.map((link) => `${link.url} - Added ${link.created_at}`).join('\n'),
					html: links.map((link) => `<a href="${link.url}">${link.url}</a> - Added ${link.created_at}`).join('<br />'),
				})
			);
		}

		return new Response(null, {
			status: 204,
		});
	},
} satisfies ExportedHandler<Env>;
