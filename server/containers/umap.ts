import { Container } from '@cloudflare/containers'
import { handleWorkersAiRequest } from '../lib/workers-ai-bridge'

export class UmapContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'

  // Python in the container reaches Workers AI by requesting this virtual
  // hostname; the handler runs in the Workers runtime with env.AI access.
  static outboundByHost = {
    'workers-ai.tong': (request: Request, env: Env) => handleWorkersAiRequest(request, env),
  }
}
