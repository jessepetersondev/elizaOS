export const SAFETY_LIMITS = {
    DUST_TOKEN_AMOUNT: 0.0001,       // Keep small to not miss sells
    MINIMUM_TRADE: 0.001,             // Keep 0.05 SOL minimum trade for testing
    MAX_POSITION_SIZE: 0.2,          // 20% max position
    MAX_SLIPPAGE: 0.20,              // Reduced from 0.30 for faster fills
    MIN_LIQUIDITY: 500,              // Reduced from 1000 for more opportunities
    MIN_VOLUME: 750,                 // Lower volume threshold for more trades
    MINIMUM_TRUST_SCORE: 0.30,       // If trustScore is below this, SELL signal is triggered.
    IDEAL_TRUST_SCORE: 0.40,         // For a BUY signal, trustScore should be at least this.
    MINIMUM_VOLUME_24H: 1000,        // Minimum 24h volume threshold
    PRICE_CHANGE_5M_THRESHOLD: 5,    // 5% threshold for 5-minute price change
    PRICE_CHANGE_24H_THRESHOLD: 10,  // 10% threshold for 24-hour price change
    TOKEN_CACHE_TTL: 60,             // 1 minute in seconds
    REENTRY_DELAY_SECONDS: 10 * 60,  // 10 minutes in seconds
    STOP_LOSS: 0.01,                 // Tight 1% stop loss for scalping
    TAKE_PROFIT: 0.05,               // Take profit at 5% (was 0.10)
    TRAILING_STOP: 0.02,             // 2% trailing stop (was 0.18)
    PARTIAL_TAKE: 0.02,              // Take 50% at 2% gain
    REENTRY_DELAY: 10 * 60 * 1000,   // Only 10 minute delay between trades
    MAX_ACTIVE_POSITIONS: 5,         // Increased from 3 for more concurrent trades
    MIN_WALLET_BALANCE: 0.1,         // Minimum balance for gas
    CHECK_INTERVAL: 60,             // Check every 60 seconds
    AGENTKIT_MIN_PROFIT_PERCENT: 2.0, // Minimum net profit percentage to trigger a sell
    AGENTKIT_STOP_LOSS_PERCENT: -1.0, // Sell if price drops more than 1% from buy price
    AGENTKIT_FEE_RATE: 0.006        // 0.6% fee per trade
};

export const SAFETY_LIMITS_BACKUP = {
    DUST_TOKEN_AMOUNT: 0.0001,      // Keep small to not miss sells
    MINIMUM_TRADE: 0.01,             // Keep 0.005 SOL minimum trade for testing
    MAX_POSITION_SIZE: 0.2,         // Keep 20% max position
    MAX_SLIPPAGE: 0.15,            // Reduced from 0.30 for faster fills
    MIN_LIQUIDITY: 500,            // Reduced from 1000 for more opportunities
    MIN_VOLUME: 750,               // Reduced from 2500 for more trades
    MIN_TRUST_SCORE: 0.1,          // Reduced from 0.3 to match new strategy
    STOP_LOSS: 0.01,               // Tight 1% stop loss for scalping
    CHECK_INTERVAL: 60,     // Check every 60 seconds
    TAKE_PROFIT: 0.05,             // Take profit at 5% (was 0.10)
    TRAILING_STOP: 0.02,           // 2% trailing stop (was 0.18)
    PARTIAL_TAKE: 0.02,            // Take 50% at 2% gain
    REENTRY_DELAY: 10 * 60 * 1000,  // Only 10 minute delay between trades
    MAX_ACTIVE_POSITIONS: 5,        // Increased from 3 for more concurrent trades
    MIN_WALLET_BALANCE: 0.1,       // Keep minimum for gas
    MINIMUM_TRUST_SCORE: 0.51,
    IDEAL_TRUST_SCORE: 0.45,
    MINIMUM_VOLUME_24H: 1000,
    PRICE_CHANGE_5M_THRESHOLD: 2,
    PRICE_CHANGE_24H_THRESHOLD: 20,
    TOKEN_CACHE_TTL: 60,            // 1 minutes in seconds
    REENTRY_DELAY_SECONDS: 10 * 60, // 10 minutes in seconds
};

export const ANALYSIS_HISTORY_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

export const MAX_TWEETS_PER_HOUR = {
  trade: 10,
  market_search: 5,
};

export const MARKET_SEARCH_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
