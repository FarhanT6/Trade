export interface Config {
  mode: 'simulation' | 'live';
  port: number;
  solanaRpcUrls: string[];
  dexscreenerBaseUrl: string;
  xBearerToken?: string;
  reddit: { clientId?: string; clientSecret?: string; userAgent: string };
  platforms: { fomo?: { baseUrl?: string; apiKey?: string }; axiom?: { baseUrl?: string; apiKey?: string }; fomp?: { baseUrl?: string } };
  anthropicApiKey?: string;
  llmModel: string;
  databaseUrl?: string;
  /** Simulation: simulated minutes advanced per real second. */
  simSpeed: number;
  simSeed: number;
  simTokens: number;
  simWallets: number;
  intendedSizeUsd: number;
  startEquityUsd: number;
  /** Live on-chain execution gates (all must be satisfied or the platform stays in paper mode). */
  live: {
    enabled: boolean;
    acknowledgement?: string;
    maxTradeUsd: number;
    dailyCapUsd: number;
    minWalletSol: number;
    maxWalletSol: number;
    jupiterSwapBaseUrl?: string;
    jupiterPriceBaseUrl?: string;
    jupiterApiKey?: string;
    slippageBps: number;
    maxPriorityFeeLamports: number;
    allowedDexes: string[];
  };
}

const env = (k: string, d?: string) => process.env[k] ?? d;

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    mode: (env('MODE', 'simulation') as Config['mode']) === 'live' ? 'live' : 'simulation',
    port: Number(env('PORT', '4000')),
    solanaRpcUrls: (env('SOLANA_RPC_URLS', 'https://api.mainnet-beta.solana.com') as string).split(',').map((s) => s.trim()).filter(Boolean),
    dexscreenerBaseUrl: env('DEXSCREENER_BASE_URL', 'https://api.dexscreener.com') as string,
    xBearerToken: env('X_BEARER_TOKEN') || undefined,
    reddit: { clientId: env('REDDIT_CLIENT_ID') || undefined, clientSecret: env('REDDIT_CLIENT_SECRET') || undefined, userAgent: env('REDDIT_USER_AGENT', 'meme-intel/0.1') as string },
    platforms: {
      fomo: { baseUrl: env('FOMO_API_BASE_URL') || undefined, apiKey: env('FOMO_API_KEY') || undefined },
      axiom: { baseUrl: env('AXIOM_API_BASE_URL') || undefined, apiKey: env('AXIOM_API_KEY') || undefined },
      fomp: { baseUrl: env('FOMP_API_BASE_URL') || undefined },
    },
    anthropicApiKey: env('ANTHROPIC_API_KEY') || undefined,
    llmModel: env('LLM_MODEL', 'claude-sonnet-5') as string,
    databaseUrl: env('DATABASE_URL') || undefined,
    simSpeed: Number(env('SIM_SPEED', '15')),
    simSeed: Number(env('SIM_SEED', '1337')),
    simTokens: Number(env('SIM_TOKENS', '36')),
    simWallets: Number(env('SIM_WALLETS', '240')),
    intendedSizeUsd: Number(env('INTENDED_SIZE_USD', '500')),
    startEquityUsd: Number(env('START_EQUITY_USD', '25000')),
    live: {
      enabled: env('LIVE_EXECUTION_ENABLED', 'false') === 'true',
      acknowledgement: env('LIVE_EXECUTION_ACK') || undefined,
      maxTradeUsd: Number(env('LIVE_MAX_TRADE_USD', '50')),
      dailyCapUsd: Number(env('LIVE_DAILY_CAP_USD', '250')),
      minWalletSol: Number(env('LIVE_MIN_WALLET_SOL', '0.05')),
      maxWalletSol: Number(env('LIVE_MAX_WALLET_SOL', '50')),
      jupiterSwapBaseUrl: env('JUPITER_SWAP_BASE_URL') || undefined,
      jupiterPriceBaseUrl: env('JUPITER_PRICE_BASE_URL') || undefined,
      jupiterApiKey: env('JUPITER_API_KEY') || undefined,
      slippageBps: Number(env('LIVE_SLIPPAGE_BPS', '300')),
      maxPriorityFeeLamports: Number(env('LIVE_MAX_PRIORITY_FEE_LAMPORTS', '2000000')),
      allowedDexes: (env('LIVE_ALLOWED_DEXES', '') as string).split(',').map((s) => s.trim()).filter(Boolean),
    },
    ...overrides,
  };
}
