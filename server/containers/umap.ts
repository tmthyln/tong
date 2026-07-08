import { Container } from '@cloudflare/containers'
import { handleWorkersAiRequest } from '../lib/workers-ai-bridge'

export class UmapContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'
}

// Python in the container reaches Workers AI by requesting this virtual
// hostname; the handler runs in the Workers runtime with env.AI access.
// NOTE: assigned after the class body on purpose — a `static outboundByHost =`
// class field would shadow the base class's static setter (define semantics)
// and the handler registry would never be populated.
UmapContainer.outboundByHost = {
  'workers-ai.tong': (request: Request, env: Env) => handleWorkersAiRequest(request, env),
}
