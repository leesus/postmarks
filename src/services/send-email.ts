export async function sendEmail(env: Env, { to, subject, text, html }: { to: string; subject: string; text: string; html: string }) {
	console.log('Sending email to', to, 'with subject', subject, 'and text', text, 'and html', html);
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
			MessageStream: 'outbound',
		}),
	});

	if (response.status === 200) {
		console.log('Email sent successfully');
	} else {
		console.error(`Failed to send email: ${await response.json()}`);
	}

	return response;
}
