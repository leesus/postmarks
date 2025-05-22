# Postmarks

We are going to build a simple RAG service that adds, lists and searches bookmarks. These can either be text, or . It receives the requests via Postmarks inbound mail API, and uses Cloudflare Workers platform to do all the smarts.

## Prerequisites

Start off by signing up for a Cloudflare Workers free plan and a Postmark plan (make sure you verify this, so you can reply to emails from within the app).

### Let's go

Start off by creating a new Cloudflare Worker and follow the prompts to make a Hello World worker:
`npm create cloudflare@latest`

Next, login to your Cloudflare account so that we can deploy our worker, and create resources:
`wrangler login`

Now that that is out of the way, let's run it and make sure everything works as expected.

`npm run dev`

Visit the URL printed in the console (http://localhost:8787) and we should see Hello, world! We’re off to the races.

Now, let’s deploy our Worker to Cloudflare, so we can setup the inbound email server on Postmark.

`npm run deploy`

Take the URL from that command (ending .workers.dev) and visit it, Hello, world! should be visible once more.

### Interlude: Postmark

At this point, let’s pause, and head over to Postmark to set up email processing. I won’t rehash their documentation... https://postmarkapp.com/developer/user-guide/inbound/configure-an-inbound-server

Make note of the inbound email address.

### Continue

Let’s handle POST requests in our Worker so we can receive an email and reply with the contents.

Grab your Postmark Server Token, and add set it as a secret.

```
echo POSTMARK_SERVER_TOKEN=YOUR_TOKEN >> .dev.vars
npx wrangler types
npx wrangler secret bulk .dev.vars
```

And edit your `src/index.ts` POST handler to reply to the email

```
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

```

Redeploy, and send another email - now we should should receive an email reply.

### Storage

Now let’s make the app a little more interesting. We’ll use Durable Objects to store our links in a SQLite database. Think of Durable Objects as a mini server per user, with their own database.

First, add a new Durable Object in `src/objects/postmarks.ts`

```
import { DurableObject } from 'cloudflare:workers';

export type Link = {
	id: string;
	email: string;
	url: string;
	created_at: string;
};

export class Postmarks extends DurableObject<Env> {
	links: Link[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS postmarks(
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT NOT NULL,
				url TEXT NOT NULL UNIQUE,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)`);

			this.links = (this.ctx.storage.sql.exec(`SELECT * FROM postmarks`).toArray() || []) as Link[];
		});
	}

	async addLink(email: string, url: string): Promise<Link> {
		const link = this.ctx.storage.sql.exec(`INSERT INTO postmarks (email, url) VALUES (?, ?) RETURNING *`, [email, url]).one() as Link;
		this.links.push(link);
		return link;
	}

	async getLinks(): Promise<Link[]> {
		return this.links;
	}
}
```

And add the necessary migrations and bindings to your `wrangler.jsonc`

```
"migrations": [
	{
		"new_sqlite_classes": ["Postmarks"],
		"tag": "v1"
	}
],
"durable_objects": {
	"bindings": [
		{
			"class_name": "Postmarks",
			"name": "POSTMARKS"
		}
	]
},
```

This code sets up the database, if it's not been instantiated already, and adds a few methods to the Durable Object to insert and list records.

Finally, let’s wire it up so we can send links and retrieve them via email. For now this is a naive implementation and relies on parsing the email subject, but we’ll improve on that later.

Add a from email to your `.dev.vars` (make sure this is set up in Postmark & your DNS settings)

```
echo FROM_EMAIL=from@yourdomain.com >> .dev.vars
npx wrangler types
npx wrangler secret bulk .dev.vars
```

Edit your worker to access your Durable Object, then based on the email subject, either add a link, list existing links, or ignore the email

```
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
```

Now, deploy `npm run deploy` and send an email to add a link - we receive a reply that it’ been added. Yay.

### Make it more exciting

Now that we’ve got storage set up, wouldn't it be cool if we could search _the content_ of those links? For that, we’ll need a vector database (Vectorize in Cloudflare), so we can visit the links, store the content, and query on it.

Start by creating a Vectorize database

```
npx wrangler vectorize create postmarks --metric cosine --preset @cf/baai/bge-large-en-v1.5
```

We also need to use Cloudflare AI and their browser rendering API, so update your bindings in `wrangler.jsonc` and add node compatibility flags, required for Puppeteer

```
"compatibility_flags": ["nodejs_compat"],
"ai": {
	"binding": "AI"
},
"browser": {
	"binding": "BROWSER"
},
"vectorize": [
	{
		"binding": "VECTORIZE",
		"index_name": "postmarks",
	}
]
```

Run `npx wrangler types` so we can access these bindings in code.

To crawl links, and store them in Vectorize, we’ll need to create a Workflow. This will take a new link, visit it using Puppeteer and then embed the content and store the vector embeddings. We’re also going to need a few new dependencies and do some housekeeping.

First, install the dependencies `npm i @cloudflare/puppeteer @langchain/textsplitters`

Next, we need to refactor the `sendEmail` function to a separate module, so we can reference it in our workflow, and change the type parameters a bit. Add the following in `src/services/send-email.ts`

```
export async function sendEmail(env: Env, { to, subject, text, html }: { to: string; subject: string; text: string; html: string }) {
	const response = await fetch('https://api.postmarkapp.com/email', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Postmark-Server-Token': env.POSTMARK_SERVER_TOKEN,
		},
		body: JSON.stringify({
			To: to,
			ReplyTo: env.REPLY_TO_EMAIL,
			From: env.FROM_EMAIL,
			Subject: subject,
			TextBody: text,
			HtmlBody: html,
		}),
	});

	if (!response.ok) {
		console.error(`Failed to send email: ${response.statusText}`);
	} else {
		return response;
	}
}
```

This means we can also email errors if anything goes wrong adding links.

Finally, we want to add a new table to our Durable Object storage to store Vectorize IDs, just to make life easier in future. Edit your `src/objects/postmarks.ts` constructor and add a new method `addVector`

```
constructor(ctx: DurableObjectState, env: Env) {
	super(ctx, env);

	ctx.blockConcurrencyWhile(async () => {
		this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS postmarks(
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			email TEXT NOT NULL UNIQUE,
			url TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`);
		this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS postmarks_vectors(
			id TEXT PRIMARY KEY NOT NULL,
			postmark_id INTEGER NOT NULL,
			FOREIGN KEY (postmark_id) REFERENCES postmarks(id) ON CASCADE DELETE
		)`);

		this.links = (this.ctx.storage.sql.exec(`SELECT * FROM postmarks`).toArray() || []) as Link[];
	});
}

...

async addVectors(id: string, postmark_id: number) {
	this.ctx.storage.sql.exec(`INSERT INTO postmarks_vectors (id, postmark_id) VALUES (?, ?)`, id, postmark_id);
}
```

Ok, on to the workflow. Add a new workflow in `src/workflows/links.ts`

```
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import puppeteer from '@cloudflare/puppeteer';
import { NonRetryableError } from 'cloudflare:workflows';
import { sendEmail } from '../services/send-email';

type Params = { email: string; url: string };

export class LinksWorkflow extends WorkflowEntrypoint<Env, Params> {
	async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		// Get the users email and the url
		const { email, url } = event.payload;

		// Get the content of the page
		let content = await step.do(`get content for ${url}`, async () => {
			try {
				const targetUrl = new URL(url);
				const browser = await puppeteer.launch(this.env.BROWSER);
				const page = await browser.newPage();
				const response = await page.goto(targetUrl.toString(), {
					waitUntil: 'networkidle0',
				});

				if (!response || response.status() !== 200) {
					throw new Error(`Non-200 response for ${url}`);
				}

				const body = await page.$('body');

				if (!body) {
					throw new Error(`Could not find body for ${url}`);
				}

				const content = await body.evaluate((el) => el.textContent);
				await browser.close();
				return content;
			} catch (error) {
				await sendEmail(this.env, {
					to: email,
					subject: 'Could not add link',
					text: `Failed to get content for ${url}`,
					html: `Failed to get content for <a href="${url}">${url}</a>`,
				});
				throw new NonRetryableError(`Failed to get content for ${url}`);
			}
		});

		// Add our link to the database
		const record = await step.do(`create database record`, async () => {
			const id = this.env.POSTMARKS.idFromName(email);
			const stub = this.env.POSTMARKS.get(id);
			try {
				const link = await stub.addLink(email, url);
				return link as { id: number; email: string; url: string; created_at: string };
			} catch (error) {
				throw new NonRetryableError(`Failed to add link to database: ${String(error)}`);
			}
		});

		// Split the content into chunks
		let texts = await step.do(`split content`, async () => {
			const splitter = new RecursiveCharacterTextSplitter({
				chunkSize: 2000,
				chunkOverlap: 50,
				separators: ['\n\n', '\n', '.', ' '],
			});
			const output = await splitter.createDocuments([content]);
			return output.map((doc) => doc.pageContent);
		});

		// Ensure we have no more than 40 chunks
		texts = await step.do(`ensure no more than 40 chunks to work around free workers limits`, async () => {
			return texts.slice(0, 40);
		});

		let embeddings: number[][] = await Promise.all(
			texts.map((text, index) => {
				return step.do(`generate embedding: ${index + 1}/${texts.length}`, async () => {
					const embeddings = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', {
						text: text,
					});
					const values = embeddings.data[0];
					if (!values) {
						throw new NonRetryableError('Failed to generate embedding');
					}

					return values;
				});
			})
		);

		let vectorIds: string[] = await Promise.all(
			embeddings.map((embedding, index) => {
				// Insert the vector into vectorize and a reference in the database
				return step.do(`insert vector: ${index + 1}/${embeddings.length}`, async () => {
					const vectorId = `${email}-${record!.id}-${index}`;
					await this.env.VECTORIZE.upsert([
						{
							id: vectorId,
							values: embedding,
							namespace: email,
							metadata: {
								url,
							},
						},
					]);
					return vectorId;
				});
			})
		);

		await step.do(`upsert vectors`, async () => {
			const id = this.env.POSTMARKS.idFromName(email);
			const stub = this.env.POSTMARKS.get(id);
			const uniqueIds = [...new Set(vectorIds)];
			await stub.addVectors(uniqueIds, record!.id);
		});

		// Send an email to the user with the link
		await step.do(`send email`, async () => {
			await sendEmail(this.env, {
				to: email,
				subject: 'Link added',
				text: `${url} - Added ${record.created_at}`,
				html: `<a href="${url}">${url}</a> - Added ${record.created_at}`,
			});
		});
	}
}
```

There’s a lot there! Here’s what’s going on:

1. Launch a headless browser and visit the link sent in the email. If it doesn’t exist, email back saying we couldn’t add it. If it does, grab the content of the page and continue.
2. Add the link to the database - we’ve moved this out of our worker into our workflow, so we don't create dead links
3. Use a text splitter to chunk the contents into more manageable pieces (we limit this to max 40 chunks, to get around free Workers subrequest limits)
4. For each chunk, create a Vector embedding, store that in Vectorize, and add a record to our database so we can easily delete Vectors later
5. Email the user to say their link was added

Finally, let’s add a binding for the workflow to our `wrangler.jsonc`

```
"workflows": [
	{
		"name": "links",
		"binding": "WORKFLOW",
		"class_name": "LinksWorkflow"
	}
]
```

Update our types `npx wrangler types`, and tweak our worker to use the workflow instead of adding links directly to the database

```
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
```

Now, if we deploy again `npm run deploy` and send an email to add a link, it should trigger our workflow and add vectors to our database. Nice!
