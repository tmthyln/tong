# Technical Implementation Details


## Dictionary, Character Structure, Stroke Count

### Data Model

The "dictionary" is split into two parts: one for terms and one for characters.
The terms portion is the traditional dictionary: headwords (terms as simplified and traditional characters, and pinyin with tone) associated with definitions.
The characters portion stores meaning- and pronunciation-independent information about a single character: stroke count, radical, and component decomposition.

### IDS Character Structure

IDS (Ideographic Description Sequences) data from the [CJKVI project](https://github.com/cjkvi/cjkvi-ids) encodes the structural decomposition of CJK characters using IDS operators (U+2FF0–U+2FFB).

#### Schema

**`char_ids`** — One row per (character × IDS decomposition variant).
- Atomic characters (no decomposition): one row with `ids_string=NULL`; `root_node_id` points to a `char` node.
- Non-atomic characters: one row per IDS variant (e.g. regional variants tagged `[GTKV]`); `root_node_id` points to the root `op` node for that variant.
- Obsolete variants (`obsolete=1`, sourced from `[O]` tag): stored for reference, excluded from structural graph (`root_node_id=NULL`).

**`char_ids_node`** — Shared DAG node pool. Three node types:
- `op`: an IDS operator (e.g. `⿰`, `⿱`); field `operator` holds the operator character.
- `char`: an atomic character leaf; field `character` holds the character value.
- `unencoded`: an unknown component represented by stroke count (①–⑳); field `stroke_count` holds 1–20.

Nodes are shared across characters: the root `op` node of 吾's decomposition is the same DB row referenced as the right child of 語's `⿰` root. This enables structural pattern queries with a single SQL join.

**`char_ids_node_link`** — DAG edges (`parent_id → child_id, position`).
- Multiple edges at the same `(parent_id, position)` with different `child_id` represent alternative decomposition variants of a referenced component.

#### Key Query Patterns

```sql
-- Character lookup: get all IDS variants for 明
SELECT id, ids_string, tags, root_node_id
FROM char_ids WHERE character = '明' AND obsolete = 0;

-- Direct containment: find characters that directly contain 日 as a component
SELECT DISTINCT c2.codepoint, c2.character
FROM char_ids_node_link l
JOIN char_ids c2 ON c2.root_node_id = l.parent_id AND c2.obsolete = 0
WHERE l.child_id IN (
  SELECT root_node_id FROM char_ids WHERE character = '日' AND obsolete = 0
);

-- Transitive containment: find all characters containing 日 (direct or indirect)
WITH RECURSIVE ancestors(node_id) AS (
  SELECT root_node_id FROM char_ids WHERE character = '日' AND obsolete = 0
  UNION ALL
  SELECT l.parent_id FROM char_ids_node_link l JOIN ancestors a ON l.child_id = a.node_id
)
SELECT DISTINCT c.codepoint, c.character
FROM ancestors a
JOIN char_ids c ON c.root_node_id = a.node_id AND c.obsolete = 0;

-- Structural pattern: find chars with ⿰ at root where right child is ⿱
SELECT DISTINCT c.character
FROM char_ids c
JOIN char_ids_node root ON root.id = c.root_node_id AND root.operator = '⿰'
JOIN char_ids_node_link l ON l.parent_id = root.id AND l.position = 1
JOIN char_ids_node right_child ON right_child.id = l.child_id AND right_child.node_type = 'op' AND right_child.operator = '⿱'
WHERE c.obsolete = 0;
```

### Querying

Basic querying of the dictionary amounts to a fts over the headwords and definitions,
returning a ranked list of matching entries.

Advanced querying translates a complex sequential query to a ranked list of matching sequences of entries.
The input is a sequence of 

Here is a rough pseudo-BNF describing the context-free grammar:


Some examples
- `放馬` - should return entries that contain 放馬, as well as the sequence of two entries for 放 and then 馬
- 
- `死馬 * 活馬` - should return entries that start with 死馬, followed by any number of characters (including nothing), followed by 活馬 (potentially followed by other characters). the results list should also include the sequence of entries [死][馬][活][馬] 
- `"success and riches"` - does a basic query using `success and riches`


## Document Ingest


## Knowledge (Entities + Relationships) Management


