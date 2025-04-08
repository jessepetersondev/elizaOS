import { elizaLogger } from "@elizaos/core";
import NodeCache from "node-cache";
import { ProcessedTokenData, TokenSecurityData, TokenTradeData, DexScreenerPair } from "../types/token";
import { toBN } from "../utils/bignumber";

export class TokenProvider {
    private cache: NodeCache;
    private isBase: boolean;
    private static lastRequestTime = 0;
    private static minTimeBetweenRequests = 2000; // 2 seconds between requests
    private static isRateLimited = false;
    private static rateLimitResetTime = 0;

    constructor(private tokenAddress: string, options?: { isBase?: boolean }) {
        this.cache = new NodeCache({ stdTTL: 300 });
        this.isBase = options?.isBase || false;
    }

    async getProcessedTokenData(): Promise<ProcessedTokenData> {
        const cacheKey = `processed_${this.tokenAddress}`;
        const cached = this.cache.get<ProcessedTokenData>(cacheKey);
        if (cached) return cached;

        try {
            // Fetch DexScreener data
            const dexData = await this.fetchDexScreenerData();
            const pair = dexData.pairs[0];

            // Calculate liquidity in USD from available data
            const liquidityUsd = pair.liquidity?.usd || (pair.priceUsd && pair.priceNative ? Number(pair.priceUsd) * Number(pair.priceNative) : 0);

            // Calculate security metrics for Solana
            const security: TokenSecurityData = {
                ownerBalance: '0',
                creatorBalance: '0',
                ownerPercentage: 0,
                creatorPercentage: 0,
                top10HolderBalance: '0',
                top10HolderPercent: 10
            };

            // Calculate trade metrics with null checks
            const tradeData: TokenTradeData = {
                price: Number(pair.priceUsd || 0),
                priceChange24h: pair.priceChange?.h24 || 0,
                volume24h: pair.volume?.h24 || 0,
                volume24hUsd: pair.volume?.h24 ? toBN(pair.volume.h24).toString() : '0',
                uniqueWallets24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
                uniqueWallets24hChange: 0
            };

            const processedData: ProcessedTokenData = {
                security,
                tradeData,
                dexScreenerData: {
                pairs: [{
                    ...pair,
                    liquidity: {
                            usd: liquidityUsd,
                            quote: 0, // Not used for Solana
                            base: 0   // Not used for Solana
                        }
                    }]
                },
                holderDistributionTrend: this.analyzeHolderDistribution(tradeData),
                highValueHolders: [],
                recentTrades: (pair.volume?.h24 || 0) > 0,
                highSupplyHoldersCount: 0,
                tokenCodex: { isScam: false }
            };

            this.cache.set(cacheKey, processedData);
            return processedData;
        } catch (error) {
            elizaLogger.error(`Failed to process token data: ${error}`);
            //throw error;
        }
    }

    private analyzeHolderDistribution(tradeData: TokenTradeData): string {
        const buyRatio = tradeData.uniqueWallets24h > 0 ?
            tradeData.uniqueWallets24hChange / tradeData.uniqueWallets24h : 0;

        if (buyRatio > 0.1) return "increasing";
        if (buyRatio < -0.1) return "decreasing";
        return "stable";
    }

    async shouldTradeToken(): Promise<boolean> {
        const data = await this.getProcessedTokenData();
        const pair = data.dexScreenerData.pairs[0];

        return (
            pair.liquidity.usd > 50000 &&
            pair.volume.h24 > 10000 &&
            Math.abs(pair.priceChange.h24) < 30 &&
            !data.tokenCodex?.isScam
        );
    }
    private async fetchDexScreenerData(): Promise<{ pairs: DexScreenerPair[] }> {
        const chainParam = this.isBase ? 'base' : 'solana';
        const dexScreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${this.tokenAddress}?chainId=${chainParam}`;

        // Check for rate limiting
        await this.applyRateLimiting();

        try {
            elizaLogger.log(`Fetching DexScreener data::::::::::::::::::::::::: ${dexScreenerUrl}`);
            const response = await fetch(dexScreenerUrl);

            // Handle rate limiting responses
            if (response.status === 429) {
                // Set rate limited flag and get retry-after header if available
                TokenProvider.isRateLimited = true;
                const retryAfter = response.headers.get('retry-after');
                const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 20000; // Default to 20s if no header

                TokenProvider.rateLimitResetTime = Date.now() + waitTime;
                elizaLogger.warn(`DexScreener rate limited. Waiting ${waitTime/1000}s before retrying.`);

                // Wait and retry recursively (with a max of 3 retries)
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.fetchDexScreenerData();
            }

            // Reset rate limited flag if successful
            TokenProvider.isRateLimited = false;
            TokenProvider.lastRequestTime = Date.now();

            if (!response.ok) {
                throw new Error(`DexScreener API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            elizaLogger.log(`DexScreener data::::::::::::::::::::::::: ${JSON.stringify(data)}`);
            return data;
        } catch (error) {
            elizaLogger.error(`Error fetching DexScreener data: ${error}`);
            // Return empty pairs array to avoid null errors
            return { pairs: [] };
        }
    }

    private async applyRateLimiting(): Promise<void> {
        const now = Date.now();

        // If we're currently rate limited, wait until reset time
        if (TokenProvider.isRateLimited && now < TokenProvider.rateLimitResetTime) {
            const waitTime = TokenProvider.rateLimitResetTime - now;
            elizaLogger.log(`Waiting for rate limit to reset (${Math.ceil(waitTime/1000)}s remaining)`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return;
        }

        // Apply normal rate limiting between requests
        const timeElapsed = now - TokenProvider.lastRequestTime;
        if (timeElapsed < TokenProvider.minTimeBetweenRequests) {
            const waitTime = TokenProvider.minTimeBetweenRequests - timeElapsed;
            elizaLogger.log(`Rate limiting DexScreener API, waiting ${waitTime}ms`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    private async fetchDexScreenerDataBackup(): Promise<{ pairs: DexScreenerPair[] }> {
        const chainParam = this.isBase ? 'base' : 'solana';
        const dexScreenerUrl = `https://api.dexscreener.com/latest/dex/tokens/${this.tokenAddress}?chainId=${chainParam}`;
        elizaLogger.log(`Fetching DexScreener data::::::::::::::::::::::::: ${dexScreenerUrl}`);
        const response = await fetch(dexScreenerUrl);
        const data = await response.json();
        elizaLogger.log(`DexScreener data::::::::::::::::::::::::: ${JSON.stringify(data)}`);
        return data;
    }
}
