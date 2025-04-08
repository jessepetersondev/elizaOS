import { elizaLogger } from "@elizaos/core";
import { TokenProvider } from "../providers/token";
import { TrustScoreProvider } from "../providers/trustScoreProvider";

export class SimulationService {
    private trustScoreProvider: TrustScoreProvider;

    constructor() {
        this.trustScoreProvider = new TrustScoreProvider();
    }
    async simulateTradeBackup(tokenAddress: string, amount: number): Promise<{
        priceImpact: number;
        recommendedAction: "EXECUTE" | "ABORT";
        reason: string;
    }> {
        try {
            const evaluation = await this.trustScoreProvider.evaluateToken(tokenAddress);
            const tokenProvider = new TokenProvider(tokenAddress);
            const tokenData = await tokenProvider.getProcessedTokenData();
            const pair = tokenData.dexScreenerData.pairs[0];

            // Calculate momentum indicators (recent buys/sells, volume, price change)
            const m5Buys = pair?.txns?.m5?.buys || 0;
            const m5Sells = pair?.txns?.m5?.sells || 0;
            const m5Volume = pair?.volume?.m5 || 0;
            const m5PriceChange = pair?.priceChange?.m5 || 0;
            const h1Volume = pair?.volume?.h1 || 0;
            const h1Buys = pair?.txns?.h1?.buys || 0;
            const h1Sells = pair?.txns?.h1?.sells || 0;
            const buyRatio = m5Buys / (m5Sells || 1);

            let recommendedAction: "EXECUTE" | "ABORT" = "ABORT";
            let reason = "Default safety check failed";

            // Pump.fun momentum and basic safety checks
            if (
                // Sufficient trading activity in last 5m or 1h
                (m5Volume > 100 || h1Volume > 1000) &&
                ((m5Buys > 2 && buyRatio >= 0.8) || (h1Buys > 10)) &&
                // Price not crashing (5m change > -15%) and 1h trend positive
                m5PriceChange > -15 &&
                h1Buys > h1Sells &&
                // Market cap sanity check (< $1M FDV to focus on microcaps)
                pair.fdv < 1000000
            ) {
                recommendedAction = "EXECUTE";
                reason = `Pump.fun momentum: ${h1Buys}/${h1Sells} 1h buys/sells, ${m5PriceChange.toFixed(1)}% 5m change, $${h1Volume.toFixed(0)} 1h vol`;
                elizaLogger.log("Pump.fun signals detected:", {
                    m5Buys, m5Sells, h1Buys, h1Sells, m5PriceChange, m5Volume, h1Volume, fdv: pair.fdv
                });
            }

            // AI TrustScore refinement
            if (evaluation.riskLevel === "HIGH" || evaluation.tradingAdvice === "SELL") {
                // Abort trade if high risk or AI recommends selling
                recommendedAction = "ABORT";
                reason = evaluation.riskLevel === "HIGH"
                    ? "TrustScore indicates HIGH risk level"
                    : `TrustScore suggests SELL: ${evaluation.reason}`;
                elizaLogger.warn("Trade aborted due to TrustScore evaluation:", {
                    riskLevel: evaluation.riskLevel,
                    tradingAdvice: evaluation.tradingAdvice,
                    reason: evaluation.reason
                });
            } else if (recommendedAction === "ABORT" && evaluation.tradingAdvice === "BUY") {
                // Execute trade if AI strongly recommends buy despite weak momentum
                recommendedAction = "EXECUTE";
                reason = `TrustScore suggests BUY: ${evaluation.reason}`;
                elizaLogger.log("Trade executed due to TrustScore suggestion despite weak momentum:", {
                    tradingAdvice: evaluation.tradingAdvice,
                    reason: evaluation.reason
                });
            }

            return {
                priceImpact: 0,  // (Price impact calc can be added if needed)
                recommendedAction,
                reason,
            };
        } catch (error) {
            elizaLogger.error("Trade simulation failed:", error);
            throw error;
        }
    }
    async simulateSolanaMemeCoinTrade(
        tokenAddress: string,
        amount: number
    ): Promise<{
        priceImpact: number;
        recommendedAction: "EXECUTE" | "ABORT";
        reason: string;
    }> {
        try {
            const evaluation = await this.trustScoreProvider.evaluateToken(tokenAddress);
            const tokenProvider = new TokenProvider(tokenAddress);
            const tokenData = await tokenProvider.getProcessedTokenData();
            const pair = tokenData.dexScreenerData.pairs[0];

            // Calculate momentum indicators
            const m5Buys = pair?.txns?.m5?.buys || 0;
            const m5Sells = pair?.txns?.m5?.sells || 0;
            const m5Volume = pair?.volume?.m5 || 0;
            const m5PriceChange = pair?.priceChange?.m5 || 0;
            const h1Volume = pair?.volume?.h1 || 0;
            const h1Buys = pair?.txns?.h1?.buys || 0;
            const h1Sells = pair?.txns?.h1?.sells || 0;
            const buyRatio = m5Buys / (m5Sells || 1);

            let recommendedAction: "EXECUTE" | "ABORT" = "ABORT";
            let reason = "Default safety check failed";

            // New pump.fun specific checks
            if (
                // Basic volume checks
                (m5Volume > 100 || h1Volume > 1000) &&

                // Transaction checks - either 5m or 1h must show activity
                ((m5Buys > 2 && buyRatio >= 0.8) || (h1Buys > 10)) &&

                // Price movement checks
                m5PriceChange > -15 && // Allow for dips

                // Positive trend in last hour
                h1Buys > h1Sells &&

                // Market cap sanity check
                pair.fdv < 1000000 // Less than $1M FDV
            ) {
                recommendedAction = "EXECUTE";
                reason = `Pump.fun momentum: ${h1Buys}/${h1Sells} 1h trades, ${m5PriceChange.toFixed(1)}% 5m change, $${h1Volume.toFixed(0)} 1h vol`;

                elizaLogger.log("Pump.fun signals detected:", {
                    m5Buys,
                    m5Sells,
                    h1Buys,
                    h1Sells,
                    m5PriceChange,
                    m5Volume,
                    h1Volume,
                    fdv: pair.fdv
                });
            }

            return {
                priceImpact: 0, // Remove price impact calculation for pump.fun tokens
                recommendedAction,
                reason,
            };
        } catch (error) {
            elizaLogger.error("Trade simulation failed:", error);
            throw error;
        }
    }
}
