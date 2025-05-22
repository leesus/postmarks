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
