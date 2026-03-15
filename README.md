# tong (通)

A web-based language learning and text understanding system for Chinese (Mandarin).
It is designed to be single user per deployment.

The system
- [lexicon] understands what characters/words/concepts the user knows. This can be used to assess the difficulty of a new passage/text and progressively increase user vocabulary.
  - [frequency lists] uses frequency lists under the hood to help maximize time spent learning characters.
- [dictionary](#dictionary-lookup) provides more specific and useful ways to query characters and phrases.
  - (fuzzy) keyword search
  - semantic search
  - structural search
- [translation](#computer-assisted-translation-cat) enables the user to translate with a super-powered autocomplete: with AI assistance or not, with all relevant context, and tools at their fingertips. 
- [knowledge graph](#entities-and-relationships) links together specific entities (with their relationships) and topics to enhance long-range connection-forming.


## Guiding Principles

1. Pre-process everything into "raw" Markdown (rich annotated text is ok, but don't deal with the complexity of XML, etc.).
2. The default level of detail is a single `document`.
   - Below the level of a document is a text `chunk`.
   - Above the level of a document, they `document`s can be grouped in a hierarchy of books, collections, series, etc.
   - At the top level is a `global` scope.

Here are high-level principles for each component of the system.
More technical details for how things are implemented are in [TECHNICAL.md](TECHNICAL.md).

### Dictionary Lookup

In some sense, a (bilingual) dictionary is simple.
The dictionary stores headwords with auxiliary information like pronunciation, definitions, examples, links, etc. indexed by headwords.
At query time, users can usually only search for headwords (although full text search over it),
but there are many other ways we may want to search (based on the information we have) using some combination of
- headwords (substring matching)
- pronunciation (especially in Chinese, where we may hear something that resolves to any of dozens of words)
- definition (reverse indexed search)
- semantic meaning (similar to definition, but more general to answer the question of "some word here that means XX" but may not match the definition well)
- substructure/stroke (knowing the number of strokes, or knowing the character component(s) for part of the character and its location)

### Entities and Relationships

Entities are extracted at the lowest level of context, scoped to individual chunks.
Some relationships are also extracted at this level (intra-chunk relationships).

Coreference resolution identifies the non-empty set of extracted chunk-scoped entities that refer to the same entity
and merges them into a single document-scoped entity.
If both entities of a relationship are promoted to distinct doc-scoped entities,
the relationship is promoted to a 

(what happens when a document changes parent folder?)

### Computer Assisted Translation (CAT)

Translation, especially of complex topics, is an inherently iterative process that pulls from a variety of knowledge stores.
- Who is this person, and where have I seen them before? (Same for projects, objects, places, etc.)
- What is this word? Should I know it or do I need to look it up? (And look-ups are contextual, dependent on the source material)
- Who is the audience, and how should certain phrases be rendered in the target language? How have I (or others) translated this kind of thing before? 
- Are there a lot of words I don't know? Am I ready to understand and translate this document?

You might start with a particular section (not necessarily the top, e.g. for papers), start reading, look up some words, start translating a bit, turn around to do some research on the topic in the target language, go back to translating, realize what some acronym means and go back and change earlier translations, etc.


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
