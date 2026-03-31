export const TONE_MARKS: Record<string, string[]> = {
  a: ['ā', 'á', 'ǎ', 'à', 'a'],
  e: ['ē', 'é', 'ě', 'è', 'e'],
  i: ['ī', 'í', 'ǐ', 'ì', 'i'],
  o: ['ō', 'ó', 'ǒ', 'ò', 'o'],
  u: ['ū', 'ú', 'ǔ', 'ù', 'u'],
  ü: ['ǖ', 'ǘ', 'ǚ', 'ǜ', 'ü'],
}

/**
 * Convert a single numbered-pinyin syllable to tone-marked form.
 * Placement rules (in priority order):
 *   1. 'a' or 'e' always takes the mark:            mai4 → mài, jie2 → jié
 *   2. 'ou' — mark goes on 'o':                     dou4 → dòu
 *   3. Otherwise mark the last vowel in the nucleus: liu2 → liú, gui4 → guì
 * Tone 5 (neutral) strips the number and returns the bare syllable: ma5 → ma
 * 'v' is treated as 'ü':                            lv4 → lǜ
 */
function syllableToMarked(syllable: string): string {
  const m = syllable.match(/^(.+?)([1-5])$/)
  if (!m) return syllable
  const syl = m[1]
  const toneStr = m[2]
  if (syl === undefined || toneStr === undefined) return syllable
  const tone = parseInt(toneStr) - 1
  const s = syl.replace(/v/g, 'ü')
  if (tone === 4) return s
  if (/[ae]/.test(s))
    return s.replace(/[ae]/, (ch) => TONE_MARKS[ch]?.[tone] ?? ch)
  if (s.includes('ou'))
    return s.replace('o', TONE_MARKS['o']?.[tone] ?? 'o')
  const match = s.match(/[iuüaeo](?=[^iuüaeo]*$)/)
  if (match && match.index !== undefined) {
    const ch = s[match.index]
    if (ch !== undefined)
      return s.slice(0, match.index) + (TONE_MARKS[ch]?.[tone] ?? ch) + s.slice(match.index + 1)
  }
  return s
}

export function pinyinToMarked(pinyin: string): string {
  return pinyin.split(' ').map(syllableToMarked).join(' ')
}

// ── Zhuyin (Bopomofo) ─────────────────────────────────────────────────────────

// Tone marks indexed by (tone digit - 1); tone 1 has no suffix in standard usage
const ZHUYIN_TONES = ['', 'ˊ', 'ˇ', 'ˋ', '˙']

const PINYIN_TO_ZHUYIN: Record<string, string> = {
  // b
  ba:'ㄅㄚ', bai:'ㄅㄞ', ban:'ㄅㄢ', bang:'ㄅㄤ', bao:'ㄅㄠ', bei:'ㄅㄟ', ben:'ㄅㄣ', beng:'ㄅㄥ',
  bi:'ㄅㄧ', bian:'ㄅㄧㄢ', biao:'ㄅㄧㄠ', bie:'ㄅㄧㄝ', bin:'ㄅㄧㄣ', bing:'ㄅㄧㄥ', bo:'ㄅㄛ', bu:'ㄅㄨ',
  // p
  pa:'ㄆㄚ', pai:'ㄆㄞ', pan:'ㄆㄢ', pang:'ㄆㄤ', pao:'ㄆㄠ', pei:'ㄆㄟ', pen:'ㄆㄣ', peng:'ㄆㄥ',
  pi:'ㄆㄧ', pian:'ㄆㄧㄢ', piao:'ㄆㄧㄠ', pie:'ㄆㄧㄝ', pin:'ㄆㄧㄣ', ping:'ㄆㄧㄥ', po:'ㄆㄛ', pou:'ㄆㄡ', pu:'ㄆㄨ',
  // m
  ma:'ㄇㄚ', mai:'ㄇㄞ', man:'ㄇㄢ', mang:'ㄇㄤ', mao:'ㄇㄠ', me:'ㄇㄜ', mei:'ㄇㄟ', men:'ㄇㄣ', meng:'ㄇㄥ',
  mi:'ㄇㄧ', mian:'ㄇㄧㄢ', miao:'ㄇㄧㄠ', mie:'ㄇㄧㄝ', min:'ㄇㄧㄣ', ming:'ㄇㄧㄥ', miu:'ㄇㄧㄡ', mo:'ㄇㄛ', mou:'ㄇㄡ', mu:'ㄇㄨ',
  // f
  fa:'ㄈㄚ', fan:'ㄈㄢ', fang:'ㄈㄤ', fei:'ㄈㄟ', fen:'ㄈㄣ', feng:'ㄈㄥ', fo:'ㄈㄛ', fou:'ㄈㄡ', fu:'ㄈㄨ',
  // d
  da:'ㄉㄚ', dai:'ㄉㄞ', dan:'ㄉㄢ', dang:'ㄉㄤ', dao:'ㄉㄠ', de:'ㄉㄜ', dei:'ㄉㄟ', den:'ㄉㄣ', deng:'ㄉㄥ',
  di:'ㄉㄧ', dia:'ㄉㄧㄚ', dian:'ㄉㄧㄢ', diao:'ㄉㄧㄠ', die:'ㄉㄧㄝ', ding:'ㄉㄧㄥ', diu:'ㄉㄧㄡ',
  dong:'ㄉㄨㄥ', dou:'ㄉㄡ', du:'ㄉㄨ', duan:'ㄉㄨㄢ', dui:'ㄉㄨㄟ', dun:'ㄉㄨㄣ', duo:'ㄉㄨㄛ',
  // t
  ta:'ㄊㄚ', tai:'ㄊㄞ', tan:'ㄊㄢ', tang:'ㄊㄤ', tao:'ㄊㄠ', te:'ㄊㄜ', teng:'ㄊㄥ',
  ti:'ㄊㄧ', tian:'ㄊㄧㄢ', tiao:'ㄊㄧㄠ', tie:'ㄊㄧㄝ', ting:'ㄊㄧㄥ',
  tong:'ㄊㄨㄥ', tou:'ㄊㄡ', tu:'ㄊㄨ', tuan:'ㄊㄨㄢ', tui:'ㄊㄨㄟ', tun:'ㄊㄨㄣ', tuo:'ㄊㄨㄛ',
  // n
  na:'ㄋㄚ', nai:'ㄋㄞ', nan:'ㄋㄢ', nang:'ㄋㄤ', nao:'ㄋㄠ', ne:'ㄋㄜ', nei:'ㄋㄟ', nen:'ㄋㄣ', neng:'ㄋㄥ',
  ni:'ㄋㄧ', nian:'ㄋㄧㄢ', niang:'ㄋㄧㄤ', niao:'ㄋㄧㄠ', nie:'ㄋㄧㄝ', nin:'ㄋㄧㄣ', ning:'ㄋㄧㄥ', niu:'ㄋㄧㄡ',
  nong:'ㄋㄨㄥ', nou:'ㄋㄡ', nu:'ㄋㄨ', nuan:'ㄋㄨㄢ', nuo:'ㄋㄨㄛ', 'nü':'ㄋㄩ', 'nüe':'ㄋㄩㄝ',
  // l
  la:'ㄌㄚ', lai:'ㄌㄞ', lan:'ㄌㄢ', lang:'ㄌㄤ', lao:'ㄌㄠ', le:'ㄌㄜ', lei:'ㄌㄟ', leng:'ㄌㄥ',
  li:'ㄌㄧ', lia:'ㄌㄧㄚ', lian:'ㄌㄧㄢ', liang:'ㄌㄧㄤ', liao:'ㄌㄧㄠ', lie:'ㄌㄧㄝ', lin:'ㄌㄧㄣ', ling:'ㄌㄧㄥ', liu:'ㄌㄧㄡ',
  long:'ㄌㄨㄥ', lou:'ㄌㄡ', lu:'ㄌㄨ', luan:'ㄌㄨㄢ', lun:'ㄌㄨㄣ', luo:'ㄌㄨㄛ', 'lü':'ㄌㄩ', 'lüe':'ㄌㄩㄝ',
  // g
  ga:'ㄍㄚ', gai:'ㄍㄞ', gan:'ㄍㄢ', gang:'ㄍㄤ', gao:'ㄍㄠ', ge:'ㄍㄜ', gei:'ㄍㄟ', gen:'ㄍㄣ', geng:'ㄍㄥ',
  gong:'ㄍㄨㄥ', gou:'ㄍㄡ', gu:'ㄍㄨ', gua:'ㄍㄨㄚ', guai:'ㄍㄨㄞ', guan:'ㄍㄨㄢ', guang:'ㄍㄨㄤ', gui:'ㄍㄨㄟ', gun:'ㄍㄨㄣ', guo:'ㄍㄨㄛ',
  // k
  ka:'ㄎㄚ', kai:'ㄎㄞ', kan:'ㄎㄢ', kang:'ㄎㄤ', kao:'ㄎㄠ', ke:'ㄎㄜ', kei:'ㄎㄟ', ken:'ㄎㄣ', keng:'ㄎㄥ',
  kong:'ㄎㄨㄥ', kou:'ㄎㄡ', ku:'ㄎㄨ', kua:'ㄎㄨㄚ', kuai:'ㄎㄨㄞ', kuan:'ㄎㄨㄢ', kuang:'ㄎㄨㄤ', kui:'ㄎㄨㄟ', kun:'ㄎㄨㄣ', kuo:'ㄎㄨㄛ',
  // h
  ha:'ㄏㄚ', hai:'ㄏㄞ', han:'ㄏㄢ', hang:'ㄏㄤ', hao:'ㄏㄠ', he:'ㄏㄜ', hei:'ㄏㄟ', hen:'ㄏㄣ', heng:'ㄏㄥ',
  hong:'ㄏㄨㄥ', hou:'ㄏㄡ', hu:'ㄏㄨ', hua:'ㄏㄨㄚ', huai:'ㄏㄨㄞ', huan:'ㄏㄨㄢ', huang:'ㄏㄨㄤ', hui:'ㄏㄨㄟ', hun:'ㄏㄨㄣ', huo:'ㄏㄨㄛ',
  // j
  ji:'ㄐㄧ', jia:'ㄐㄧㄚ', jian:'ㄐㄧㄢ', jiang:'ㄐㄧㄤ', jiao:'ㄐㄧㄠ', jie:'ㄐㄧㄝ', jin:'ㄐㄧㄣ', jing:'ㄐㄧㄥ', jiong:'ㄐㄩㄥ', jiu:'ㄐㄧㄡ',
  ju:'ㄐㄩ', juan:'ㄐㄩㄢ', jue:'ㄐㄩㄝ', jun:'ㄐㄩㄣ',
  // q
  qi:'ㄑㄧ', qia:'ㄑㄧㄚ', qian:'ㄑㄧㄢ', qiang:'ㄑㄧㄤ', qiao:'ㄑㄧㄠ', qie:'ㄑㄧㄝ', qin:'ㄑㄧㄣ', qing:'ㄑㄧㄥ', qiong:'ㄑㄩㄥ', qiu:'ㄑㄧㄡ',
  qu:'ㄑㄩ', quan:'ㄑㄩㄢ', que:'ㄑㄩㄝ', qun:'ㄑㄩㄣ',
  // x
  xi:'ㄒㄧ', xia:'ㄒㄧㄚ', xian:'ㄒㄧㄢ', xiang:'ㄒㄧㄤ', xiao:'ㄒㄧㄠ', xie:'ㄒㄧㄝ', xin:'ㄒㄧㄣ', xing:'ㄒㄧㄥ', xiong:'ㄒㄩㄥ', xiu:'ㄒㄧㄡ',
  xu:'ㄒㄩ', xuan:'ㄒㄩㄢ', xue:'ㄒㄩㄝ', xun:'ㄒㄩㄣ',
  // zh
  zha:'ㄓㄚ', zhai:'ㄓㄞ', zhan:'ㄓㄢ', zhang:'ㄓㄤ', zhao:'ㄓㄠ', zhe:'ㄓㄜ', zhei:'ㄓㄟ', zhen:'ㄓㄣ', zheng:'ㄓㄥ', zhi:'ㄓ',
  zhong:'ㄓㄨㄥ', zhou:'ㄓㄡ', zhu:'ㄓㄨ', zhua:'ㄓㄨㄚ', zhuai:'ㄓㄨㄞ', zhuan:'ㄓㄨㄢ', zhuang:'ㄓㄨㄤ', zhui:'ㄓㄨㄟ', zhun:'ㄓㄨㄣ', zhuo:'ㄓㄨㄛ',
  // ch
  cha:'ㄔㄚ', chai:'ㄔㄞ', chan:'ㄔㄢ', chang:'ㄔㄤ', chao:'ㄔㄠ', che:'ㄔㄜ', chen:'ㄔㄣ', cheng:'ㄔㄥ', chi:'ㄔ',
  chong:'ㄔㄨㄥ', chou:'ㄔㄡ', chu:'ㄔㄨ', chua:'ㄔㄨㄚ', chuai:'ㄔㄨㄞ', chuan:'ㄔㄨㄢ', chuang:'ㄔㄨㄤ', chui:'ㄔㄨㄟ', chun:'ㄔㄨㄣ', chuo:'ㄔㄨㄛ',
  // sh
  sha:'ㄕㄚ', shai:'ㄕㄞ', shan:'ㄕㄢ', shang:'ㄕㄤ', shao:'ㄕㄠ', she:'ㄕㄜ', shei:'ㄕㄟ', shen:'ㄕㄣ', sheng:'ㄕㄥ', shi:'ㄕ',
  shou:'ㄕㄡ', shu:'ㄕㄨ', shua:'ㄕㄨㄚ', shuai:'ㄕㄨㄞ', shuan:'ㄕㄨㄢ', shuang:'ㄕㄨㄤ', shui:'ㄕㄨㄟ', shun:'ㄕㄨㄣ', shuo:'ㄕㄨㄛ',
  // r
  ran:'ㄖㄢ', rang:'ㄖㄤ', rao:'ㄖㄠ', re:'ㄖㄜ', ren:'ㄖㄣ', reng:'ㄖㄥ', ri:'ㄖ',
  rong:'ㄖㄨㄥ', rou:'ㄖㄡ', ru:'ㄖㄨ', rua:'ㄖㄨㄚ', ruan:'ㄖㄨㄢ', rui:'ㄖㄨㄟ', run:'ㄖㄨㄣ', ruo:'ㄖㄨㄛ',
  // z
  za:'ㄗㄚ', zai:'ㄗㄞ', zan:'ㄗㄢ', zang:'ㄗㄤ', zao:'ㄗㄠ', ze:'ㄗㄜ', zei:'ㄗㄟ', zen:'ㄗㄣ', zeng:'ㄗㄥ', zi:'ㄗ',
  zong:'ㄗㄨㄥ', zou:'ㄗㄡ', zu:'ㄗㄨ', zuan:'ㄗㄨㄢ', zui:'ㄗㄨㄟ', zun:'ㄗㄨㄣ', zuo:'ㄗㄨㄛ',
  // c
  ca:'ㄘㄚ', cai:'ㄘㄞ', can:'ㄘㄢ', cang:'ㄘㄤ', cao:'ㄘㄠ', ce:'ㄘㄜ', cen:'ㄘㄣ', ceng:'ㄘㄥ', ci:'ㄘ',
  cong:'ㄘㄨㄥ', cou:'ㄘㄡ', cu:'ㄘㄨ', cuan:'ㄘㄨㄢ', cui:'ㄘㄨㄟ', cun:'ㄘㄨㄣ', cuo:'ㄘㄨㄛ',
  // s
  sa:'ㄙㄚ', sai:'ㄙㄞ', san:'ㄙㄢ', sang:'ㄙㄤ', sao:'ㄙㄠ', se:'ㄙㄜ', sen:'ㄙㄣ', seng:'ㄙㄥ', si:'ㄙ',
  song:'ㄙㄨㄥ', sou:'ㄙㄡ', su:'ㄙㄨ', suan:'ㄙㄨㄢ', sui:'ㄙㄨㄟ', sun:'ㄙㄨㄣ', suo:'ㄙㄨㄛ',
  // standalone vowels
  a:'ㄚ', ai:'ㄞ', an:'ㄢ', ang:'ㄤ', ao:'ㄠ',
  e:'ㄜ', ei:'ㄟ', en:'ㄣ', eng:'ㄥ', er:'ㄦ',
  o:'ㄛ',
  // y- (medial ㄧ)
  yi:'ㄧ', ya:'ㄧㄚ', yan:'ㄧㄢ', yang:'ㄧㄤ', yao:'ㄧㄠ', ye:'ㄧㄝ', you:'ㄧㄡ', yin:'ㄧㄣ', ying:'ㄧㄥ', yong:'ㄩㄥ',
  // w- (medial ㄨ)
  wu:'ㄨ', wa:'ㄨㄚ', wai:'ㄨㄞ', wan:'ㄨㄢ', wang:'ㄨㄤ', wei:'ㄨㄟ', wen:'ㄨㄣ', weng:'ㄨㄥ', wo:'ㄨㄛ',
  // yu- (medial ㄩ)
  yu:'ㄩ', yuan:'ㄩㄢ', yue:'ㄩㄝ', yun:'ㄩㄣ',
}

function syllableToZhuyin(syllable: string): string {
  const m = syllable.match(/^(.+?)([1-5])$/)
  if (!m) return syllable
  const base = m[1]!.replace('v', 'ü')
  const tone = parseInt(m[2]!) - 1
  const body = PINYIN_TO_ZHUYIN[base] ?? base
  return body + (ZHUYIN_TONES[tone] ?? '')
}

export function pinyinToZhuyin(pinyin: string): string {
  return pinyin.split(' ').map(syllableToZhuyin).join(' ')
}

// ── Wade-Giles ────────────────────────────────────────────────────────────────

// Superscript tone digits appended after the syllable
const WG_TONES = ['¹', '²', '³', '⁴', '⁵']

const PINYIN_TO_WG: Record<string, string> = {
  // b → p
  ba:'pa', bai:'pai', ban:'pan', bang:'pang', bao:'pao', bei:'pei', ben:'pên', beng:'pêng',
  bi:'pi', bian:'pien', biao:'piao', bie:'pieh', bin:'pin', bing:'ping', bo:'po', bu:'pu',
  // p → p'
  pa:"p'a", pai:"p'ai", pan:"p'an", pang:"p'ang", pao:"p'ao", pei:"p'ei", pen:"p'ên", peng:"p'êng",
  pi:"p'i", pian:"p'ien", piao:"p'iao", pie:"p'ieh", pin:"p'in", ping:"p'ing", po:"p'o", pou:"p'ou", pu:"p'u",
  // m
  ma:'ma', mai:'mai', man:'man', mang:'mang', mao:'mao', me:'me', mei:'mei', men:'mên', meng:'mêng',
  mi:'mi', mian:'mien', miao:'miao', mie:'mieh', min:'min', ming:'ming', miu:'miu', mo:'mo', mou:'mou', mu:'mu',
  // f
  fa:'fa', fan:'fan', fang:'fang', fei:'fei', fen:'fên', feng:'fêng', fo:'fo', fou:'fou', fu:'fu',
  // d → t
  da:'ta', dai:'tai', dan:'tan', dang:'tang', dao:'tao', de:'tê', dei:'tei', den:'tên', deng:'têng',
  di:'ti', dia:'tia', dian:'tien', diao:'tiao', die:'tieh', ding:'ting', diu:'tiu',
  dong:'tung', dou:'tou', du:'tu', duan:'tuan', dui:'tui', dun:'tun', duo:'to',
  // t → t'
  ta:"t'a", tai:"t'ai", tan:"t'an", tang:"t'ang", tao:"t'ao", te:"t'ê", teng:"t'êng",
  ti:"t'i", tian:"t'ien", tiao:"t'iao", tie:"t'ieh", ting:"t'ing",
  tong:"t'ung", tou:"t'ou", tu:"t'u", tuan:"t'uan", tui:"t'ui", tun:"t'un", tuo:"t'o",
  // n
  na:'na', nai:'nai', nan:'nan', nang:'nang', nao:'nao', ne:'nê', nei:'nei', nen:'nên', neng:'nêng',
  ni:'ni', nian:'nien', niang:'niang', niao:'niao', nie:'nieh', nin:'nin', ning:'ning', niu:'niu',
  nong:'nung', nou:'nou', nu:'nu', nuan:'nuan', nuo:'no', 'nü':'nü', 'nüe':'nüeh',
  // l
  la:'la', lai:'lai', lan:'lan', lang:'lang', lao:'lao', le:'lê', lei:'lei', leng:'lêng',
  li:'li', lia:'lia', lian:'lien', liang:'liang', liao:'liao', lie:'lieh', lin:'lin', ling:'ling', liu:'liu',
  long:'lung', lou:'lou', lu:'lu', luan:'luan', lun:'lun', luo:'lo', 'lü':'lü', 'lüe':'lüeh',
  // g → k
  ga:'ka', gai:'kai', gan:'kan', gang:'kang', gao:'kao', ge:'kê', gei:'kei', gen:'kên', geng:'kêng',
  gong:'kung', gou:'kou', gu:'ku', gua:'kua', guai:'kuai', guan:'kuan', guang:'kuang', gui:'kuei', gun:'kun', guo:'kuo',
  // k → k'
  ka:"k'a", kai:"k'ai", kan:"k'an", kang:"k'ang", kao:"k'ao", ke:"k'ê", ken:"k'ên", keng:"k'êng",
  kong:"k'ung", kou:"k'ou", ku:"k'u", kua:"k'ua", kuai:"k'uai", kuan:"k'uan", kuang:"k'uang", kui:"k'uei", kun:"k'un", kuo:"k'uo",
  // h
  ha:'ha', hai:'hai', han:'han', hang:'hang', hao:'hao', he:'hê', hei:'hei', hen:'hên', heng:'hêng',
  hong:'hung', hou:'hou', hu:'hu', hua:'hua', huai:'huai', huan:'huan', huang:'huang', hui:'hui', hun:'hun', huo:'huo',
  // j → ch (+ ü-group)
  ji:'chi', jia:'chia', jian:'chien', jiang:'chiang', jiao:'chiao', jie:'chieh', jin:'chin', jing:'ching', jiong:'chiung', jiu:'chiu',
  ju:'chü', juan:'chüan', jue:'chüeh', jun:'chün',
  // q → ch'
  qi:"ch'i", qia:"ch'ia", qian:"ch'ien", qiang:"ch'iang", qiao:"ch'iao", qie:"ch'ieh", qin:"ch'in", qing:"ch'ing", qiong:"ch'iung", qiu:"ch'iu",
  qu:"ch'ü", quan:"ch'üan", que:"ch'üeh", qun:"ch'ün",
  // x → hs
  xi:'hsi', xia:'hsia', xian:'hsien', xiang:'hsiang', xiao:'hsiao', xie:'hsieh', xin:'hsin', xing:'hsing', xiong:'hsiung', xiu:'hsiu',
  xu:'hsü', xuan:'hsüan', xue:'hsüeh', xun:'hsün',
  // zh → ch
  zha:'cha', zhai:'chai', zhan:'chan', zhang:'chang', zhao:'chao', zhe:'chê', zhei:'chei', zhen:'chên', zheng:'chêng', zhi:'chih',
  zhong:'chung', zhou:'chou', zhu:'chu', zhua:'chua', zhuai:'chuai', zhuan:'chuan', zhuang:'chuang', zhui:'chui', zhun:'chun', zhuo:'cho',
  // ch → ch'
  cha:"ch'a", chai:"ch'ai", chan:"ch'an", chang:"ch'ang", chao:"ch'ao", che:"ch'ê", chen:"ch'ên", cheng:"ch'êng", chi:"ch'ih",
  chong:"ch'ung", chou:"ch'ou", chu:"ch'u", chua:"ch'ua", chuai:"ch'uai", chuan:"ch'uan", chuang:"ch'uang", chui:"ch'ui", chun:"ch'un", chuo:"ch'o",
  // sh
  sha:'sha', shai:'shai', shan:'shan', shang:'shang', shao:'shao', she:'shê', shei:'shei', shen:'shên', sheng:'shêng', shi:'shih',
  shou:'shou', shu:'shu', shua:'shua', shuai:'shuai', shuan:'shuan', shuang:'shuang', shui:'shui', shun:'shun', shuo:'shuo',
  // r → j
  ran:'jan', rang:'jang', rao:'jao', re:'jê', ren:'jên', reng:'jêng', ri:'jih',
  rong:'jung', rou:'jou', ru:'ju', rua:'jua', ruan:'juan', rui:'jui', run:'jun', ruo:'jo',
  // z → ts
  za:'tsa', zai:'tsai', zan:'tsan', zang:'tsang', zao:'tsao', ze:'tsê', zei:'tsei', zen:'tsên', zeng:'tsêng', zi:'tzu',
  zong:'tsung', zou:'tsou', zu:'tsu', zuan:'tsuan', zui:'tsui', zun:'tsun', zuo:'tso',
  // c → ts'
  ca:"ts'a", cai:"ts'ai", can:"ts'an", cang:"ts'ang", cao:"ts'ao", ce:"ts'ê", cen:"ts'ên", ceng:"ts'êng", ci:"tz'u",
  cong:"ts'ung", cou:"ts'ou", cu:"ts'u", cuan:"ts'uan", cui:"ts'ui", cun:"ts'un", cuo:"ts'o",
  // s
  sa:'sa', sai:'sai', san:'san', sang:'sang', sao:'sao', se:'sê', sen:'sên', seng:'sêng', si:'ssu',
  song:'sung', sou:'sou', su:'su', suan:'suan', sui:'sui', sun:'sun', suo:'so',
  // standalone vowels
  a:'a', ai:'ai', an:'an', ang:'ang', ao:'ao',
  e:'ê', ei:'ei', en:'ên', eng:'êng', er:'êrh',
  o:'o',
  // y- series
  yi:'i', ya:'ya', yan:'yen', yang:'yang', yao:'yao', ye:'yeh', you:'yu', yin:'yin', ying:'ying', yong:'yung',
  // w- series
  wu:'wu', wa:'wa', wai:'wai', wan:'wan', wang:'wang', wei:'wei', wen:'wên', weng:'wêng', wo:'wo',
  // yu- series
  yu:'yü', yuan:'yüan', yue:'yüeh', yun:'yün',
}

function syllableToWadeGiles(syllable: string): string {
  const m = syllable.match(/^(.+?)([1-5])$/)
  if (!m) return syllable
  const base = m[1]!.replace('v', 'ü')
  const tone = parseInt(m[2]!) - 1
  const body = PINYIN_TO_WG[base] ?? base
  return body + (WG_TONES[tone] ?? '')
}

export function pinyinToWadeGiles(pinyin: string): string {
  return pinyin.split(' ').map(syllableToWadeGiles).join(' ')
}

// ── Format dispatcher ─────────────────────────────────────────────────────────

export function pinyinToFormat(pinyin: string, format: string): string {
  if (format === 'pinyin')        return pinyin
  if (format === 'marked-pinyin') return pinyinToMarked(pinyin)
  if (format === 'zhuyin')        return pinyinToZhuyin(pinyin)
  if (format === 'wade-giles')    return pinyinToWadeGiles(pinyin)
  return pinyin
}
