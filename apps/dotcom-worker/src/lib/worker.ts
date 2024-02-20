/// <reference no-default-lib="true"/>
/// <reference types="@cloudflare/workers-types" />
import { Router, createCors } from 'itty-router'
import { env } from 'process'
import Toucan from 'toucan-js'
import { createRoom } from './routes/createRoom'
import { createRoomSnapshot } from './routes/createRoomSnapshot'
import { forwardRoomRequest } from './routes/forwardRoomRequest'
import { getRoomHistory } from './routes/getRoomHistory'
import { getRoomHistorySnapshot } from './routes/getRoomHistorySnapshot'
import { getRoomSnapshot } from './routes/getRoomSnapshot'
import { joinExistingRoom } from './routes/joinExistingRoom'
import { Environment } from './types'
import { fourOhFour } from './utils/fourOhFour'
export { TLDrawDurableObject } from './TLDrawDurableObject'

const { preflight, corsify } = createCors({
	origins: Object.assign([], { includes: (origin: string) => isAllowedOrigin(origin) }),
})

const router = Router()
	.all('*', preflight)
	.all('*', blockUnknownOrigins)
	.post('/new-room', createRoom)
	.post('/snapshots', createRoomSnapshot)
	.get('/snapshot/:roomId', getRoomSnapshot)
	.get('/r/:roomId', joinExistingRoom)
	.get('/r/:roomId/history', getRoomHistory)
	.get('/r/:roomId/history/:timestamp', getRoomHistorySnapshot)
	.post('/r/:roomId/restore', forwardRoomRequest)
	.all('*', fourOhFour)

const Worker = {
	fetch(request: Request, env: Environment, context: ExecutionContext) {
		const sentry = new Toucan({
			dsn: env.SENTRY_DSN,
			context, // Includes 'waitUntil', which is essential for Sentry logs to be delivered. Modules workers do not include 'request' in context -- you'll need to set it separately.
			request, // request is not included in 'context', so we set it here.
			allowedHeaders: ['user-agent'],
			allowedSearchParams: /(.*)/,
		})

		return router
			.handle(request, env, context)
			.catch((err) => {
				console.error(err)
				sentry.captureException(err)

				return new Response('Something went wrong', {
					status: 500,
					statusText: 'Internal Server Error',
				})
			})
			.then((response) => {
				const setCookies = response.headers.getAll('set-cookie')
				// unfortunately corsify mishandles the set-cookie header, so
				// we need to manually add it back in
				const result = corsify(response)
				if ([...setCookies].length === 0) {
					return result
				}
				const newResponse = new Response(result.body, result)
				newResponse.headers.delete('set-cookie')
				// add cookies from original response
				for (const cookie of setCookies) {
					newResponse.headers.append('set-cookie', cookie)
				}
				return newResponse
			})
	},
}

function isAllowedOrigin(origin: string) {
	return true
}

async function blockUnknownOrigins(request: Request) {
	// allow requests for the same origin (new rewrite routing for SPA)
	if (request.headers.get('sec-fetch-site') === 'same-origin') {
		return undefined
	}

	if (new URL(request.url).pathname === '/auth/callback') {
		// allow auth callback because we use the special cookie to verify
		// the request
		return undefined
	}

	const origin = request.headers.get('origin')
	if (env.IS_LOCAL !== 'true' && (!origin || !isAllowedOrigin(origin))) {
		console.error('Attempting to connect from an invalid origin:', origin, env, request)
		return new Response('Not allowed', { status: 403 })
	}

	// origin doesn't match, so we can continue
	return undefined
}

export default Worker
