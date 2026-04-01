import { Hono } from 'hono'
import lexiconRoutes from './routes/lexicon'
import libraryRoutes from './routes/library'
import libraryVisualizationRoutes from './routes/library-visualization'
import graphTypeRoutes from './routes/graph-types'
import dictionaryRoutes from './routes/dictionary'
import knowledgeRoutes from './routes/knowledge'
import authRoutes from './routes/auth'
import preferencesRoutes from './routes/preferences'

export { IngestDocumentWorkflow } from './workflows/ingest-document'
export { RefreshCedictWorkflow } from './workflows/refresh-cedict'
export { RefreshCharIdsWorkflow } from './workflows/refresh-char-ids'
export { Lexicon } from './lexicon'
export { UmapContainer } from './containers/umap'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/auth', authRoutes)
app.route('/api/lexicon', lexiconRoutes)
app.route('/api/library', libraryRoutes)
app.route('/api/library/visualization', libraryVisualizationRoutes)
app.route('/api/graph-types', graphTypeRoutes)
app.route('/api/dictionary', dictionaryRoutes)
app.route('/api/knowledge', knowledgeRoutes)
app.route('/api/preferences', preferencesRoutes)

export default app
