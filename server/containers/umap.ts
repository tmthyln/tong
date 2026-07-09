import { Container } from '@cloudflare/containers'
import { handleWorkersAiRequest, WORKERS_AI_VIRTUAL_HOST } from '../lib/workers-ai-bridge'

export class UmapContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'
  // Tell the Python client where the bridge lives, from the same constant used
  // as the interception key below — one owner for the virtual hostname.
  envVars = { WORKERS_AI_BASE_URL: `http://${WORKERS_AI_VIRTUAL_HOST}` }
}

// Python in the container reaches Workers AI by requesting this virtual
// hostname; the handler runs in the Workers runtime with env.AI access.
// NOTE: assigned after the class body on purpose — a `static outboundByHost =`
// class field would shadow the base class's static setter (define semantics)
// and the handler registry would never be populated.
UmapContainer.outboundByHost = {
  [WORKERS_AI_VIRTUAL_HOST]: (request: Request, env: Env) => handleWorkersAiRequest(request, env),
}
