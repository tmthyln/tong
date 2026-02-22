# tong

A web-based language learning and text understanding system for Chinese (Mandarin).
It is designed to be single user per deployment.

The system
- [lexicon] understands what characters/words/concepts the user knows. This can be used to assess the difficulty of a new passage/text and progressively increase user vocabulary.
- [frequency lists] uses frequency lists under the hood to help maximize time spent learning characters.
- [dictionary] provides more specific and useful ways to query characters and phrases.
  - (fuzzy) keyword search
  - semantic search
  - structural search
- [translation] enables the user to translate with a super-powered autocomplete: with AI assistance or not, with all relevant context, and tools at their fingertips. 
- [knowledge graph] links together specific entities (with their relationships) and topics to enhance long-range connection-forming.


## Guiding Principles

1. Pre-process everything into "raw" Markdown (rich annotated text is ok, but don't deal with the complexity of XML, etc.).
2. The default level of detail is a single `document`.
   - Below the level of a document is a text `chunk`.
   - Above the level of a document, they `document`s can be grouped in a hierarchy of books, collections, series, etc.
   - At the top level is a `global` scope.


## Setup

### Initial configuration

These steps only need to be done once per deployment instance.

```shell
# create D1 database
npx wrangler d1 create tong  # output database id needs to be set in wrangler.toml

# create R2 bucket
npx wrangler r2 bucket create tong-documents

# create vector stores
npx wrangler vectorize create tong-doc-chunks --dimensions=768 --metric=cosine
```


## Plan

These are the outstanding tasks and major directions for the future of the project.

- Visual analytic for understanding the whole corpus of documents by topic
- When processing documents, extract a local knowledge graph from each chunk
  - extract entities based on a list of possible types
  - extract relationships based on a list of possible types
- Users can identify new entities (with potentially new entity types) in text, which can trigger reprocessing of other documents
- Dictionary lookups of single characters or phrases (or longer strings of text) using a combination of lookup methods:
  - term-matching on headwords
  - matching on pinyin/zhuyin pronunciation with tones
  - structural matching on subcomponents
- Integrated dictionary lookup in native text
  - Highlight some text and ask for definitions with context
- Tailored agentic workflows for document understanding and translation
  - during translation, identify a thing/entity and ask "what is this, what is known about them, and what is relevant to my current task?"
