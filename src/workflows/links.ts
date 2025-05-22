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
