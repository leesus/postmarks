# Postmarks

We are going to build a simple RAG service that adds, lists and searches bookmarks. These can either be text, or . It receives the requests via Postmarks inbound mail API, and uses Cloudflare Workers platform to do all the smarts.

## Prerequisites

Start off by signing up for a Cloudflare Workers free plan and a Postmark plan.

### Let's go

Start off by creating a new Cloudflare Worker and follow the prompts to make a Hello World worker with Durable Object:
`npm create cloudflare@latest`

Next, login to your Cloudflare account so that we can deploy our worker, and create resources:
`wrangler login`

Now that that is out of the way, let's run it and make sure everything works as expected.

`npm run dev`

Visit the URL printed in the console (http://localhost:8787) and we should see Hello, world! We’re off to the races.

Now, let's deploy our Worker to Cloudflare, so we can setup the inbound email server on Postmark.

`npm run deploy`
