# Technical Implementation Details


## Dictionary, Character Structure, Stroke Count

### Data Model

The "dictionary" is split into two parts: one for terms and one for characters.
The terms portion is the traditional dictionary: headwords (terms as simplified and traditional characters, and pinyin with tone) associated with definitions.
The characters portion stores meaning- and pronunciation-independent information about a single character: stroke count, radical, and component decomposition.

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


