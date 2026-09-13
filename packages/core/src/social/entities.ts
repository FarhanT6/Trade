/** Entity extraction for posts: tickers, contract addresses, urls, narrative keywords. */

const SOL_ADDR = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const EVM_ADDR = /\b0x[a-fA-F0-9]{40}\b/g;
const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,12})\b/g;
const HASHTAG = /#([A-Za-z][A-Za-z0-9_]{1,30})\b/g;
const URL = /https?:\/\/[^\s)]+/g;

export interface ExtractedEntities {
  tickers: string[];
  contracts: string[];
  urls: string[];
  hashtags: string[];
}

export function extractEntities(text: string): ExtractedEntities {
  const tickers = new Set<string>();
  const contracts = new Set<string>();
  const urls = new Set<string>();
  const hashtags = new Set<string>();
  for (const m of text.matchAll(CASHTAG)) tickers.add(m[1].toUpperCase());
  for (const m of text.matchAll(HASHTAG)) hashtags.add(m[1].toLowerCase());
  for (const m of text.matchAll(URL)) urls.add(m[0]);
  const noUrls = text.replace(URL, ' ');
  for (const m of noUrls.matchAll(SOL_ADDR)) contracts.add(m[0]);
  for (const m of noUrls.matchAll(EVM_ADDR)) contracts.add(m[0].toLowerCase());
  return { tickers: [...tickers], contracts: [...contracts], urls: [...urls], hashtags: [...hashtags] };
}

const STOP = new Set(
  'the a an and or of to in on for is are was were be been it its this that with as at by from up out if not no so we you they i me my our your their he she his her them do does did have has had will would can could should just very more most much many some any all like about into over than then there here when where what which who how why also get got going gonna lets let us am im dont cant wont rt via'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(URL, ' ')
    .replace(/[^a-z0-9$#\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && w.length <= 20 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Text with tickers, contract addresses and urls removed: what a post is *about*, not which token it names. */
export function themeText(text: string): string {
  return text.replace(URL, ' ').replace(CASHTAG, ' ').replace(SOL_ADDR, ' ').replace(EVM_ADDR, ' ');
}

/**
 * Resolve a post to token mints. Contract addresses win over tickers (spec §18:
 * "resolve by contract/mint address, not ticker alone"). Ambiguous tickers map to
 * every candidate and are flagged.
 */
export function resolveTokens(
  entities: ExtractedEntities,
  bySymbol: Map<string, string[]>,
  byMint: Set<string>,
): { mints: string[]; ambiguous: boolean } {
  const mints = new Set<string>();
  for (const c of entities.contracts) if (byMint.has(c)) mints.add(c);
  let ambiguous = false;
  if (mints.size === 0) {
    for (const t of entities.tickers) {
      const cands = bySymbol.get(t) ?? [];
      if (cands.length > 1) ambiguous = true;
      for (const m of cands) mints.add(m);
    }
  }
  return { mints: [...mints], ambiguous };
}
