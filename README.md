# Postmarks

We are going to build a simple RAG service that adds, lists and searches bookmarks. These can either be text, or . It receives the requests via Postmarks inbound mail API, and uses Cloudflare Workers platform to do all the smarts.

## Prerequisites

Start off by signing up for a Cloudflare Workers free plan and a Postmark plan.

### Let's go

Start off by creating a new Cloudflare Worker and follow the prompts to make a Hello World worker with Durable Object:
`npm create cloudflare@latest`
