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
		const link = this.ctx.storage.sql.exec(`INSERT INTO postmarks (email, url) VALUES (?, ?) RETURNING *`, email, url).one() as Link;
		this.links.push(link);
		return link;
	}

	async getLinks(): Promise<Link[]> {
		return this.links;
	}
}
