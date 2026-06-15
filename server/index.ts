import { Hono } from 'hono'
import { routeAgentRequest, getAgentByName } from 'agents'
import lexiconRoutes from './routes/lexicon'
import libraryRoutes from './routes/library'
import libraryVisualizationRoutes from './routes/library-visualization'
import graphTypeRoutes from './routes/graph-types'
import dictionaryRoutes from './routes/dictionary'
import knowledgeRoutes from './routes/knowledge'
import knowledgeScopeRoutes from './routes/knowledge-scope'
import authRoutes from './routes/auth'
import preferencesRoutes from './routes/preferences'
import devEvalRoutes from './routes/dev-eval'

export { IngestDocumentWorkflow } from './workflows/ingest-document'
export { RefreshCedictWorkflow } from './workflows/refresh-cedict'
export { RefreshCharIdsWorkflow } from './workflows/refresh-char-ids'
export { Lexicon } from './lexicon'
export { UmapContainer } from './containers/umap'
export { TranslationAgent } from './agent/translation-agent'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/auth', authRoutes)
app.route('/api/lexicon', lexiconRoutes)
app.route('/api/library', libraryRoutes)
app.route('/api/library/visualization', libraryVisualizationRoutes)
app.route('/api/graph-types', graphTypeRoutes)
app.route('/api/dictionary', dictionaryRoutes)
app.route('/api/knowledge', knowledgeRoutes)
app.route('/api/knowledge-scope', knowledgeScopeRoutes)
app.route('/api/preferences', preferencesRoutes)
app.route('/api/dev/eval', devEvalRoutes)

// Agents SDK owns `/agents/*` (WebSocket + RPC for the TranslationAgent);
// everything else falls through to the Hono app.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/agents/')) {
      // Some dev runtimes (the Cloudflare Vite plugin) don't populate
      // `ctx.id.name` for idFromName-addressed DOs, so PartyServer can't resolve
      // `this.name` and throws in onStart. Pre-bootstrap the instance via
      // getAgentByName (which calls setName → persists the name to storage, so it
      // survives hibernation) before routing. No-op in production.
      const instanceName = url.pathname.split('/')[3]
      if (instanceName) {
        try {
          await getAgentByName(env.TRANSLATION_AGENT, decodeURIComponent(instanceName))
        } catch (err) {
          console.error('[agent] name bootstrap failed', err)
        }
      }
      const agentResponse = await routeAgentRequest(request, env)
      if (agentResponse) return agentResponse
    }
    return app.fetch(request, env, ctx)
  },
}
