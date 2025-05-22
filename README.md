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
