import { Hono } from 'hono'
import lexiconRoutes from './routes/lexicon'
import libraryRoutes from './routes/library'
import graphTypeRoutes from './routes/graph-types'
import dictionaryRoutes from './routes/dictionary'

export { IngestDocumentWorkflow } from './workflows/ingest-document'
export { RefreshCedictWorkflow } from './workflows/refresh-cedict'
export { Lexicon } from './lexicon'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/lexicon', lexiconRoutes)
app.route('/api/library', libraryRoutes)
app.route('/api/graph-types', graphTypeRoutes)
app.route('/api/dictionary', dictionaryRoutes)

export default app
