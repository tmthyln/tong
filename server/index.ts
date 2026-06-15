import { Hono } from 'hono'
import { routeAgentRequest } from 'agents'
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
    return (await routeAgentRequest(request, env)) ?? app.fetch(request, env, ctx)
  },
}
