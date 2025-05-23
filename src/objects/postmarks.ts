import { DurableObject } from 'cloudflare:workers';

export type Link = {
	id: number;
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
			this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS postmarks_vectors(
				id TEXT PRIMARY KEY NOT NULL,
				postmark_id INTEGER NOT NULL,
				FOREIGN KEY (postmark_id) REFERENCES postmarks(id) ON DELETE CASCADE
			)`);

			this.links = (this.ctx.storage.sql.exec(`SELECT * FROM postmarks`).toArray() || []) as Link[];
		});
	}

	async addLink(email: string, url: string): Promise<Link> {
		const link = this.ctx.storage.sql.exec(`INSERT INTO postmarks (email, url) VALUES (?, ?) RETURNING *`, email, url).one() as Link;
		this.links.push(link);
		return link;
	}

	async addVectors(ids: string[], postmark_id: number) {
		for (const id of ids) {
			this.ctx.storage.sql.exec(`INSERT INTO postmarks_vectors (id, postmark_id) VALUES (?, ?)`, id, postmark_id);
		}
	}

	async getLinks(): Promise<Link[]> {
		return this.links;
	}

	async queryLink(email: string, query: string): Promise<Link | null> {
		const embeddings = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', {
			text: query,
		});
		const vectors = embeddings.data[0];

		const vectorQuery = await this.env.VECTORIZE.query(vectors, { topK: 1, returnMetadata: 'all', namespace: email });
		let match;
		if (vectorQuery.matches && vectorQuery.matches.length > 0 && vectorQuery.matches[0]) {
			[match] = vectorQuery.matches;
		} else {
			console.log('No matching vector found');
			return null;
		}

		let link = this.links.find((link) => link.url === match!.metadata!.url) as Link | null;
		return link;
	}
}
