-- Migration number: 0007 	 2026-02-04

-- Revised node type definitions with clearer boundaries and counterfactuals

UPDATE node_type SET definition = 'A specific individual human being, whether real, historical, or fictional. Includes figures referenced by name, courtesy name, or well-known epithet. Does NOT include references to groups of people (e.g. 百姓, 学生们), but does include deities and mythological beings, whether depicted as human or mythical characters.'
WHERE name = 'PERSON';

UPDATE node_type SET definition = 'A geopolitical entity: a region defined by political or administrative boundaries, such as a country, kingdom, dynasty-state, province, prefecture, city, or district. Must have, have had, or implies having a governing authority. Does NOT include physical geographic features like mountains, rivers, or lakes (use LOCATION), nor organizations or institutions that happen to be named after places (use ORGANIZATION).'
WHERE name = 'GPE';

UPDATE node_type SET definition = 'A named physical location or geographic feature that is NOT defined by political boundaries. Includes mountains, rivers, lakes, seas, deserts, buildings, temples, palaces, bridges, and other landmarks. Does NOT include cities, countries, provinces, or other politically-defined regions (use GPE), nor generic directional references (e.g. 南方, 东边).'
WHERE name = 'LOCATION';

UPDATE node_type SET definition = 'A specific, physical object, artifact, document, or tangible item. Includes named texts, books, inventions, weapons, artworks, and instruments. Does NOT include generic categories of objects (e.g. 书, 剑), abstract concepts or ideas, nor skills or abilities (use ABILITY).'
WHERE name = 'OBJECT';

UPDATE node_type SET definition = 'An organized group of people with a shared purpose or structure. Includes political parties, institutions, schools of thought, companies, military units, and formal associations. Does NOT include informal or unnamed groups that represent a class of people (e.g. 农民, 士兵) unless they refer to a specific group in the text, geopolitical entities like countries or states (use GPE), nor ethnic or cultural groups unless they function as an organized body.'
WHERE name = 'ORGANIZATION';

UPDATE node_type SET definition = 'A specific, identifiable point or period in time. Includes exact dates, years, named dynasties, named eras, named reign periods, and seasons tied to a specific year. Does NOT include durations or spans of time without a fixed anchor (use TIME.INTERVAL), vague temporal references (e.g. 古代, 以前, 后来), nor recurring times (e.g. 每天, 春天 when not referring to a specific spring).'
WHERE name = 'TIME.ABSOLUTE';

UPDATE node_type SET definition = 'A duration, span, or length of time without reference to a specific fixed point. Includes phrases like 三年, 几个月, 很长时间, 一会儿. Does NOT include specific dates, years, or named periods (use TIME.ABSOLUTE), nor vague temporal adverbs (e.g. 以前, 最近, 经常).'
WHERE name = 'TIME.INTERVAL';

UPDATE node_type SET definition = 'A learnable skill, talent, craft, or area of practiced competency. Includes martial arts, calligraphy, musical performance, language proficiency, and technical skills. Does NOT include one-time actions or verbs (e.g. 跑, 吃), occupations or roles (e.g. 医生, 教师), nor inherent personal qualities or states (use STATE).'
WHERE name = 'ABILITY';

UPDATE node_type SET definition = 'A temporary or enduring condition, quality, emotion, or state of being that describes an entity at a point in time. Includes emotions (幸福, 悲伤), physical conditions (饥饿, 疲倦), and situational states (繁荣, 混乱, 和平). Does NOT include actions or events that caused the state (use EVENT), skills or competencies (use ABILITY), nor permanent inherent properties that define what something is rather than how it is.'
WHERE name = 'STATE';

UPDATE node_type SET definition = 'A specific, named occurrence or happening that took place at a particular time or period. Includes wars, battles, revolutions, treaties, ceremonies, natural disasters, and other notable incidents. Does NOT include ongoing conditions or states (use STATE), named time periods or eras (use TIME.ABSOLUTE), nor general processes or trends (e.g. 工业化, 现代化).'
WHERE name = 'EVENT';