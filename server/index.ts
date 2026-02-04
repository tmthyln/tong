import { Hono } from 'hono'
import lexiconRoutes from './routes/lexicon'
import libraryRoutes from './routes/library'

export { IngestDocumentWorkflow } from './workflows/ingest-document'
export { Lexicon } from './lexicon'

const app = new Hono<{ Bindings: Env }>()

app.route('/api/lexicon', lexiconRoutes)
app.route('/api/library', libraryRoutes)

export default app