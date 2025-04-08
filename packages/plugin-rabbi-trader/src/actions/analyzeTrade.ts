import {
    Action,
    composeContext,
    elizaLogger,
    generateText,
    ModelClass,
    parseJSONObjectFromText,
} from "@elizaos/core";

export const analyzeTradeAction: Action = {
    name: "ANALYZE_TRADE",
    description: "Analyze a token for trading opportunities",
    similes: [
        "ANALYZE",
        "ANALYZE_TOKEN",
        "TRADE",
        "ANALYZE_TRADE",
        "EVALUATE",
        "ASSESS",
    ],
    examples: [],
    validate: async () => true,
    handler: async (runtime, memory, state, params, callback) => {
        try {
            // composeState
            if (!state) {
                state = await runtime.composeState(memory);
            } else state = await runtime.updateRecentMessageState(state);

            const tokenData = {
                walletBalance: params.walletBalance,
                tokenAddress: params.tokenAddress,
                price: params.price,
                volume: params.volume,
                marketCap: params.marketCap,
                liquidity: params.liquidity,
                holderDistribution: params.holderDistribution,
                trustScore: params.trustScore,
                dexscreener: params.dexscreener,
                position: params.position,
            };

            // Direct prompt instead of template
            ////const prompt = `Analyze the following token data and provide a trading recommendation.
            // Return the response as a JSON object with the following structure:
            // {
            // "recommendation": "BUY" | "SELL" | "HOLD",
            // "confidence": number (0-100),
            // "reasoning": string,
            // "risks": string[],
            // "opportunities": string[]
            // }

            // Token Data:
            // ${JSON.stringify(tokenData, null, 2)}`;
            const prompt = `Analyze the following Solana Meme Coin Token Data using every available on-chain, off-chain, and market data. Provide a comprehensive trading recommendation for immediate trading by reviewing all aspects of the coin's behavior. Consider the following signals and factors:

            CRITICAL SIGNALS (in order of importance):
            1. Early momentum within the first 30 minutes, with particular emphasis on the last 5 minutes.
            2. Buy/Sell ratio over the last 5 minutes.
            3. Volume spike in the last 5 minutes.
            4. Price change percentage in the last 5 minutes.
            5. Number of unique buyers and overall trade count in the last 5 minutes.
            6. Fully Diluted Valuation (FDV) — aggressive buys are more favorable if FDV is under $100k.
            7. On-chain signals such as liquidity levels, trading frequency, token distribution, and overall market sentiment.
            8. Technical indicators (e.g. RSI, MACD) if available, to support momentum and reversal signals.
            9. Recent news or external market factors that could affect short-term trading.
            10. Historical performance data and volatility measures to assess risk.

            AGGRESSIVE BUY TRIGGERS:
            - A significantly higher number of buys than sells in the last 5 minutes.
            - A price increase of more than 20% in the last 5 minutes.
            - A substantial volume spike in the last 5 minutes.
            - More than 10 trades occurring in the last 5 minutes.
            - FDV under $100k.
            - Strong on-chain liquidity and positive sentiment indicators.

            Thoroughly analyze these aspects and provide a recommendation on whether to BUY, SELL, or HOLD this token for immediate trading. Your response must include a confidence score (0-100), detailed reasoning covering technical, on-chain, and market sentiment factors, and list potential risks and opportunities.

            Return your answer strictly as JSON with the following structure:
            {
                "recommendation": "BUY" | "SELL" | "HOLD",
                "confidence": number, // 0-100
                "reasoning": string,
                "risks": string[],
                "opportunities": string[]
            }

            Token Data:
            ${JSON.stringify(tokenData, null, 2)}`;

            // Generate analysis using direct prompt
            const content = await generateText({
                runtime,
                context: prompt,
                modelClass: ModelClass.LARGE,
            });

            if (!content) {
                throw new Error("No analysis generated");
            }

            elizaLogger.log(`Raw analysis response:`, content);

            // Parse the response to get the recommended action
            const recommendation = parseJSONObjectFromText(content);
            elizaLogger.log(
                `Parsed recommendation for ${params.tokenAddress}:`,
                recommendation
            );

            // Send result through callback
            if (callback) {
                await callback({
                    text: JSON.stringify(recommendation),
                    type: "analysis",
                });
            }

            return true;
        } catch (error) {
            elizaLogger.error(`Analysis failed:`, {
                error: error instanceof Error ? error.message : "Unknown error",
                stack: error instanceof Error ? error.stack : undefined,
            });
            return false;
        }
    },
};
