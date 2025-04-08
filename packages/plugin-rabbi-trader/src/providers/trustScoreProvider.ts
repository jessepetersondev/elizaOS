import { elizaLogger } from "@elizaos/core";
import { TokenProvider } from "./token";
import { ProcessedTokenData } from "../types/token";
import { SAFETY_LIMITS } from "../constants";

export class TrustScoreProvider {
    private tokenProviders: Map<string, TokenProvider> = new Map();

    getTokenProvider(tokenAddress: string): TokenProvider {
        if (!this.tokenProviders.has(tokenAddress)) {
            this.tokenProviders.set(tokenAddress, new TokenProvider(tokenAddress));
        }
        return this.tokenProviders.get(tokenAddress)!;
    }

    async calculateTrustScore(tokenData: ProcessedTokenData): Promise<number> {
        const pair = tokenData.dexScreenerData.pairs[0];
        const {
            liquidity,
            volume,
            marketCap
        } = pair;

        // Weight factors
        const LIQUIDITY_WEIGHT = 0.4;
        const VOLUME_WEIGHT = 0.4;
        const MCAP_WEIGHT = 0.2;

        // Calculate component scores
        const liquidityScore = Math.min(liquidity.usd / 100000, 1) * LIQUIDITY_WEIGHT;
        const volumeScore = Math.min(volume.h24 / 50000, 1) * VOLUME_WEIGHT;
        const mcapScore = Math.min(marketCap / 1000000, 1) * MCAP_WEIGHT;

        return liquidityScore + volumeScore + mcapScore;
    }
    async evaluateToken(tokenAddress: string): Promise<{
        trustScore: number;
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
        tradingAdvice: "BUY" | "SELL" | "HOLD";
        reason: string;
        stopMonitoring: boolean;
    }> {
        try {
            const provider = this.getTokenProvider(tokenAddress);
            const tokenData = await provider.getProcessedTokenData();
            const trustScore = await this.calculateTrustScore(tokenData);
            const pair = tokenData.dexScreenerData.pairs[0];

            // Determine risk level based on trustScore
            const riskLevel = trustScore > SAFETY_LIMITS.MINIMUM_TRUST_SCORE
                ? "LOW"
                : trustScore > SAFETY_LIMITS.IDEAL_TRUST_SCORE
                    ? "MEDIUM"
                    : "HIGH";

            // Initialize trading advice and reason
            let tradingAdvice: "BUY" | "SELL" | "HOLD" = "HOLD";
            let reason = "Market conditions appear neutral.";

            const priceChange5m = pair.priceChange.m5;
            const priceChange24h = pair.priceChange.h24;
            const volume24h = pair.volume.h24;

            // Aggressive BUY conditions:
            // If the price has increased at least 5% in the last 5 minutes or 10% over 24h,
            // the trust score is strong (>= ideal), and volume is above the minimum threshold.
            if (
                ((priceChange5m >= 5) || (priceChange24h >= 10)) &&
                (trustScore >= SAFETY_LIMITS.IDEAL_TRUST_SCORE) &&
                (volume24h >= SAFETY_LIMITS.MIN_VOLUME)
            ) {
                tradingAdvice = "BUY";
                reason = `Aggressive Buy: Price up ${priceChange5m.toFixed(1)}% (5m) / ${priceChange24h.toFixed(1)}% (24h) with strong volume and trust score.`;
            }
            // Aggressive SELL conditions:
            // If the price drops by 5% or more in 5 minutes or trustScore is critically low.
            else if (
                (priceChange5m <= -5) ||
                (trustScore <= SAFETY_LIMITS.MINIMUM_TRUST_SCORE)
            ) {
                tradingAdvice = "SELL";
                reason = `Aggressive Sell: Price down ${priceChange5m.toFixed(1)}% (5m) or low trust score detected.`;
            }

            // Determine if monitoring should be stopped for tokens trending sharply downward.
            let stopMonitoring = false;
            if (
                priceChange5m < -20 ||
                (priceChange5m < -15 && trustScore < 0.15) ||
                trustScore < 0.08
            ) {
                stopMonitoring = true;
                tradingAdvice = "SELL"; // Force a sell signal
                reason = "Token trending sharply downward; high risk detected, stop monitoring.";
            }
            elizaLogger.log(`trustScore ------- ${tokenAddress}:`, {
                trustScore,
                riskLevel,
                tradingAdvice,
                reason,
                stopMonitoring
            });
            return { trustScore, riskLevel, tradingAdvice, reason, stopMonitoring };
        } catch (error) {
            elizaLogger.error(`Trust evaluation failed: ${error}`);
            throw error;
        }
    }


    async evaluateToken2(tokenAddress: string): Promise<{
        trustScore: number;
        riskLevel: "LOW" | "MEDIUM" | "HIGH";
        tradingAdvice: "BUY" | "SELL" | "HOLD";
        reason: string;
        stopMonitoring: boolean;
    }> {
        try {
            const provider = this.getTokenProvider(tokenAddress);
            const tokenData = await provider.getProcessedTokenData();
            const trustScore = await this.calculateTrustScore(tokenData);
            const pair = tokenData.dexScreenerData.pairs[0];

            // More lenient risk assessment
            const riskLevel = trustScore > SAFETY_LIMITS.MINIMUM_TRUST_SCORE ? "LOW" : trustScore > SAFETY_LIMITS.IDEAL_TRUST_SCORE ? "MEDIUM" : "HIGH";

            // Trading signals using available timeframes
            let tradingAdvice: "BUY" | "SELL" | "HOLD" = "HOLD";
            let reason = "Market conditions stable";

            const priceChange5m = pair.priceChange.m5;
            const priceChange24h = pair.priceChange.h24;
            const volume24h = pair.volume.h24;

            // More aggressive buy conditions
            if ((priceChange5m > SAFETY_LIMITS.PRICE_CHANGE_5M_THRESHOLD || priceChange24h > SAFETY_LIMITS.PRICE_CHANGE_24H_THRESHOLD) &&
                trustScore > SAFETY_LIMITS.IDEAL_TRUST_SCORE &&
                volume24h > SAFETY_LIMITS.MIN_VOLUME) {
                tradingAdvice = "BUY";
                reason = `Strong momentum: 5m ${priceChange5m.toFixed(1)}% / 24h ${priceChange24h.toFixed(1)}%`;
            }
            // Quick to sell on downtrends
            else if (priceChange5m < -SAFETY_LIMITS.PRICE_CHANGE_5M_THRESHOLD || trustScore < SAFETY_LIMITS.MINIMUM_TRUST_SCORE) {
                tradingAdvice = "SELL";
                reason = "Price decline or risk increase";
            }

            // Determine if monitoring should be stopped for new pump.fun tokens here
            // If the 5-minute price drop is greater than 20%
            // or if the trustScore is critically low, then stop monitoring.
            let stopMonitoring = false;
            if (priceChange5m < -20 || // Increased from -25
                (priceChange5m < -15 && trustScore < 0.15) || // Combined condition
                trustScore < 0.08) {
                stopMonitoring = true;
                reason = "Token trending downward or high risk detected, stop monitoring";
                tradingAdvice = "SELL"; // force a sell signal if needed
            }

            return { trustScore, riskLevel, tradingAdvice, reason, stopMonitoring };
        } catch (error) {
            elizaLogger.error(`Trust evaluation failed: ${error}`);
            throw error;
        }
    }
}
