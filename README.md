# Knsept Brake Worker

A small Cloudflare Worker that pauses a runaway queue in your own account when
[Knsept Guard](https://knsept.com) asks it to.

Guard watches your usage from outside your account with a read-only token. When a queue you chose
goes over its daily budget, Guard sends this Worker a signed request, and the Worker pauses the
queue's delivery. It stays paused until you resume it, from the Guard dashboard or in Cloudflare.
Messages wait in the queue for its retention period (4 days by default). Producers can still
send while it's paused, and those writes are billed.

## What it can and can't do

- It holds a Cloudflare API token that can edit your queues. Knsept never sees that token.
- It acts only on queues you list in `BRAKE_QUEUES`. Any other queue is refused.
- It acts only on a request signed with your `BRAKE_SECRET`, less than two minutes old, that it
  hasn't seen before. It remembers request ids in a small Durable Object of its own.
- It pauses and resumes delivery. It never deletes a queue or a message, and it can't touch
  anything but queues.
- It has no dependencies. All of its code is in `src/`; read it before you deploy it.

## Set it up

You need Node.js and a Cloudflare account on the Workers Paid plan (Queues needs it).

1. Create an API token at https://dash.cloudflare.com/profile/api-tokens with one permission:
   **Account > Queues > Edit**, for the account the queues are in.

2. Get the code and install wrangler:

   ```sh
   git clone https://github.com/jaig-eye/knsept-brake.git
   cd knsept-brake
   npm install
   ```

3. In `wrangler.jsonc`, set `CLOUDFLARE_ACCOUNT_ID` to your account ID and `BRAKE_QUEUES` to the
   queues Guard may pause, separated by commas, for example `"orders,emails"`.

4. Deploy it, then give it the token:

   ```sh
   npx wrangler deploy
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   ```

   Note the address `wrangler deploy` prints, like
   `https://knsept-brake.your-subdomain.workers.dev`.

5. In the Guard dashboard, under **Brakes**, paste that address. Guard shows a signing secret once.
   Set it on the Worker:

   ```sh
   npx wrangler secret put BRAKE_SECRET
   ```

6. Press **Test the Brake Worker** in the dashboard. It should list your queues.

7. Give a queue its own daily budget in the dashboard and tick **Pause this queue's delivery when
   it goes over**.

## Change or remove it

- To stop Guard pausing a queue, untick its brake in the dashboard, or take it out of
  `BRAKE_QUEUES` and deploy again.
- To change the secret, save the address again in the dashboard and set the new secret with
  `wrangler secret put BRAKE_SECRET`. The old one stops working at once.
- To remove it, press **Remove** in the dashboard, then `npx wrangler delete`, and delete the API
  token in Cloudflare.

## The request

Guard sends:

```
POST /
Content-Type: application/json
Knsept-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" keyed with BRAKE_SECRET>

{"id":"<random>","action":"check" | "pause" | "resume","queue":"<name>"}
```

`check` lists the queues in `BRAKE_QUEUES`, whether each exists and whether it's paused. To prove
its token can edit queues, it sets the first queue's delivery to the state it's already in, which
changes nothing. See `src/protocol.ts` for the details.

## Run the tests

```sh
npm install
npm test
```

## License

MIT. See `LICENSE`.
