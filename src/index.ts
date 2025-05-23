import { Postmarks } from './objects/postmarks';
import { LinksWorkflow } from './workflows/links';
import { sendEmail } from './services/send-email';
import { generateText, tool } from 'ai';
import { valibotSchema } from '@ai-sdk/valibot';
import * as v from 'valibot';
import { createWorkersAI } from 'workers-ai-provider';

export { Postmarks, LinksWorkflow };

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method !== 'POST') {
			return new Response('Not Found', { status: 404 });
		}

		const message = (await request.json()) as Record<string, string>;
		const { From: email, Subject: subject, TextBody: body } = message;

		// This creates a new Durable Object instance for the user’s email address
		const id = env.POSTMARKS.idFromName(email as string);
		const postmarks = env.POSTMARKS.get(id);

		const workersai = createWorkersAI({
			binding: env.AI,
		});

		const response = await generateText({
			model: workersai('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
			system: `You are an assistant that parses incoming email subjects and bodies and routes the request to the appropriate tool.
				The user has a database of links/urls. The email will either contain a URL, or a keyword that indicates the user wants to list their links, or a query to search for a link.`,
			prompt: `${subject ? `<email_subject>${subject}</email_subject>` : ''}
				${body ? `<email_body>${body}</email_body>` : ''}

				You can only perform one of the following actions:
				- Add a link - whenever the subject or body contains a URL
				- List all of the user's links
				- Find a link based on a given query
			`,
			tools: {
				addLink: tool({
					description: "Add a link to the user's database",
					parameters: valibotSchema(
						v.object({
							url: v.pipe(v.string(), v.url()),
						})
					),
					execute: async ({ url }) => {
						await env.WORKFLOW.create({ params: { email, url } });
						return 'Link added';
					},
				}),
				listLinks: tool({
					description: "List all of the user's links",
					parameters: valibotSchema(v.object({})),
					execute: async () => {
						const links = await postmarks.getLinks();
						let text: string, html: string;

						if (links.length) {
							text = links.map((link) => `${link.url} - Added ${link.created_at}`).join('\n');
							html = links.map((link) => `<a href="${link.url}">${link.url}</a> - Added ${link.created_at}`).join('<br />');
						} else {
							text = 'No links found';
							html = 'No links found';
						}

						ctx.waitUntil(
							sendEmail(env, {
								to: email,
								subject: 'Your links',
								text,
								html,
							})
						);

						return text;
					},
				}),
				queryLink: tool({
					description: 'Search for a link based on a given query',
					parameters: valibotSchema(
						v.object({
							query: v.string(),
						})
					),
					execute: async ({ query }) => {
						const link = await postmarks.queryLink(email, query);
						let text: string, html: string;

						if (link) {
							text = `Your query '${query}' found the following link:\n${link.url} - Added ${link.created_at}`;
							html = `Your query '${query}' found the following link:<br /><a href="${link.url}">${link.url}</a> - Added ${link.created_at}`;
						} else {
							text = `Your query '${query}' did not find any links`;
							html = `Your query '${query}' did not find any links`;
						}

						ctx.waitUntil(
							sendEmail(env, {
								to: email,
								subject: 'Your link search results',
								text,
								html,
							})
						);

						return text;
					},
				}),
			},
		});

		return new Response(JSON.stringify(response.text), {
			status: 200,
		});
	},
} satisfies ExportedHandler<Env>;
