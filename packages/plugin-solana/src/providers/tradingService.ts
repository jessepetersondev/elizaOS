import {
    TrustScoreDatabase,
    TokenPerformance
} from "@elizaos/plugin-trustdb";
//import { TwitterClientInterface } from "@elizaos/client-twitter";
import { Connection, PublicKey } from "@solana/web3.js";
import { TokenProvider } from "./token.ts";
import { Client, IAgentRuntime, Memory, elizaLogger } from "@elizaos/core";
import { WalletProvider } from "./wallet.ts";
import { ProcessedTokenData, TokenTradeData } from "../types/token.ts";
import Airtable from "airtable";
import {
    RSI, MACD, EMA, SMA, WMA, WEMA, ROC,
    BollingerBands, ADX, ATR, CCI, ForceIndex,
    StochasticRSI, PSAR, OBV, TRIX, KST, Stochastic,
    WilliamsR, AwesomeOscillator, IchimokuCloud,
    VWAP, MFI
} from 'technicalindicators';
import { SwapMessage, SwapProvider } from "./swap.ts";
import { v4 as uuidv4 } from "uuid";
import {
    TradeAlert,
    TradeBuyAlert,
    tweetTrade,
    TwitterConfigSchema,
    TwitterService,
} from "../services/twitter";

interface SimulatedTrade {
    entryIndex: number;
    exitIndex: number;
    entryPrice: number;
    exitPrice: number;
    profit: number;
  }

interface SellDetails {
    sell_amount: number;
    sell_recommender_id: string | null;
}

// SellDecision interface
interface SellDecision {
    tokenPerformance: TokenPerformance;
    amountToSell: number;
    sell_recommender_id: string | null;
}

interface TradeDecision {
    tokenPerformance: TokenPerformance;
    amount: number;
    recommender_id: string | null;
    type: 'buy' | 'sell';
}

interface BuyDetails {
    buy_amount: number;
    buy_recommender_id: string | null;
    initial_market_cap?: number;
}

interface TradePlan {
    tokenAddress: string;
    action: 'buy' | 'sell' | 'hold';
    reasoning: string[];
}
interface Config {
    AIRTABLE_API_KEY: string;
    AIRTABLE_BASE_ID: string;
    AIRTABLE_TABLE_NAME: string;
}

interface BacktestResult {
    strategyName: string;
    totalProfit?: number;
    trades?: Array<{
        type: 'buy' | 'sell';
        price: number;
        timestamp: string;
        profit?: number;
    }>;
    metrics?: {
        winRate: number;
        averageProfit: number;
    };
    signals: {
        shouldBuy: number;
        shouldSell: number;
    };
}

enum StrategyType {
    MOMENTUM = 'momentum',
    TREND = 'trend',
    TBD = 'tbd'
}

interface TradingStrategy {
    name: string;
    type: StrategyType;
    params: {
        rsiPeriod?: number;
        rsiOverbought?: number;
        rsiOversold?: number;
        macdFast?: number;
        macdSlow?: number;
        macdSignal?: number;
        shortEMA?: number;
        longEMA?: number;
        stochPeriod?: number;
        kPeriod?: number;
        dPeriod?: number;
        mfiPeriod?: number;
        adxPeriod?: number;
        forcePeriod?: number;
        aoFast?: number;
        aoSlow?: number;
        rocPeriod?: number;
        williamsRPeriod?: number;
        cciPeriod?: number;
        trixPeriod?: number;
        bbPeriod?: number;
        bbStdDev?: number;
        conversionPeriod?: number;
        basePeriod?: number;
        spanPeriod?: number;
        displacement?: number;
        psarStep?: number;
        psarMax?: number;
    };
}

interface TradingExecutionConfig {
    BACKEND_URL: string;
    SOLANA_RPC_URL: string;
    BASE_MINT: string;
    AUTO_TRADE_ENABLED: boolean;
}

class TradingExecutionManager {
    private isRunning: boolean = false;
    private config: Config;
    private airtableBase: Airtable.Base;
    private lastCheck: Date = new Date();
    private monitoredTokens: Set<string> = new Set();
    private runningProcesses: Set<string> = new Set();
    private swapProvider: SwapProvider;
    private baseMint: PublicKey;

    constructor(
        private runtime: IAgentRuntime,
        private trustScoreDb: TrustScoreDatabase,
        private walletProvider: WalletProvider,
        private backendUrl: string
    ) {
        this.config = {
            AIRTABLE_API_KEY: runtime.getSetting("AIRTABLE_API_KEY"),
            AIRTABLE_BASE_ID: runtime.getSetting("AIRTABLE_BASE_ID"),
            AIRTABLE_TABLE_NAME: runtime.getSetting("AIRTABLE_TABLE_NAME")
        };
        this.runtime = runtime;
        this.swapProvider = new SwapProvider(new Connection(runtime.getSetting("SOLANA_RPC_URL")));
        this.baseMint = new PublicKey(
            runtime.getSetting("BASE_MINT") ||
            "So11111111111111111111111111111111111111112"
        );


        this.airtableBase = new Airtable({ apiKey: this.config.AIRTABLE_API_KEY }).base(this.config.AIRTABLE_BASE_ID);
    }

    /**
     * Calculates a trade confidence (0 to 1) by comparing buy and sell signal percentages.
     * A value closer to 1 means high confidence to buy.
     */
    private async calculateTradeConfidence(tokenAddress: string): Promise<number> {
        const trustEvaluation = await this.evaluateTradingOpportunity(tokenAddress);
        // netSignal is the difference between buy and sell percentages (range: -100 to +100)
        const netSignal = trustEvaluation.buyPercentage - trustEvaluation.sellPercentage;
        // Normalize to a 0-1 range (e.g. -100 -> 0, +100 -> 1)
        const confidence = Math.max(0, Math.min(1, (netSignal + 100) / 200));
        elizaLogger.log(`Trade confidence for ${tokenAddress}: ${confidence}`);
        return confidence;
    }

    /**
     * Calculates a dynamic position size based on confidence and available capital.
     * Here, we risk up to 5% of our capital on a trade, scaled by confidence.
     */
    private calculatePositionSize(availableCapital: number): number {
        const maxFraction = 0.50; // maximum 50% of available capital
        const fraction = maxFraction;
        const positionSize = availableCapital * fraction;
        elizaLogger.log(`Calculated position size: ${positionSize} (Capital: ${availableCapital})`);
        return positionSize;
    }

    private async shouldSell(tokenAddress: string, currentPrice: number): Promise<boolean> {
        try {
            // Get the buy price from our last trade
            const lastTrade = await this.trustScoreDb.getLatestTradePerformance(tokenAddress, null, true);
            if (!lastTrade || !lastTrade.buy_price) {
                return false;
            }

            // Calculate profit percentage
            const profitPercent = ((currentPrice - lastTrade.buy_price) / lastTrade.buy_price) * 100;

            // Check stop loss (-30%) or take profit (20%)
            if (profitPercent <= -30) {
                elizaLogger.log(`Stop loss triggered for ${tokenAddress}: ${profitPercent.toFixed(2)}%`);
                return true;
            }

            // Sell if profit is 20% or more
            if (profitPercent >= 20) {
                elizaLogger.log(`Profit target reached for ${tokenAddress}: ${profitPercent.toFixed(2)}%`);
                return true;
            }

            return false;
        } catch (error) {
            elizaLogger.error(`Error in shouldSell for ${tokenAddress}:`, error);
            return false;
        }
    }

    private async updateAirtableStatus(tokenAddress: string, newStatus: string) {
        try {
            const airtableBase = new Airtable({ apiKey: this.config.AIRTABLE_API_KEY }).base(this.config.AIRTABLE_BASE_ID);
            const records = await airtableBase(this.config.AIRTABLE_TABLE_NAME)
                .select({
                    filterByFormula: `{Mint} = '${tokenAddress}'`
                })
                .firstPage();

            if (records && records.length > 0) {
                await airtableBase(this.config.AIRTABLE_TABLE_NAME).update([
                    {
                        id: records[0].id,
                        fields: {
                            Status: [newStatus]
                        }
                    }
                ]);
                elizaLogger.log(`Updated Airtable status for token ${tokenAddress} to "${newStatus}"`);
            }
        } catch (error) {
            elizaLogger.error(`Error updating Airtable status for ${tokenAddress}:`, error);
        }
    }

    async monitorPrices() {
        // Check each active position we're monitoring
        for (const tokenAddress of this.runningProcesses) {
            try {
                const tokenProvider = new TokenProvider(tokenAddress, this.walletProvider, this.runtime.cacheManager);
                const processedData = await tokenProvider.getProcessedTokenData();
                const currentPrice = processedData.tradeData.price;

                // Check if we should sell
                if (await this.shouldSell(tokenAddress, currentPrice)) {
                    // Get real token performance data
                    const tokenPerformance = await this.trustScoreDb.getTokenPerformance(tokenAddress);

                    elizaLogger.log(`[SIMULATION] Would sell ${tokenAddress}`);
                    await this.executeSellDecision({
                        tokenPerformance: tokenPerformance,
                        amountToSell: this.trustScoreDb.getTokenBalance(tokenAddress),
                        sell_recommender_id: null
                    });

                    elizaLogger.log(`Stopped monitoring position for token ${tokenAddress}`);
                }
            } catch (error) {
                elizaLogger.error(`Error monitoring ${tokenAddress}:`, error);
            }
        }
    }


    /**
     * Formats a UUID string into a standardized format with hyphens
     * @param id - Input UUID string. If not provided, generates a new UUID
     * @returns Formatted UUID string in format "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
     */
    formatUUID(id: string) {
        const uuid = id || uuidv4();
        const [s1, s2, s3, s4, s5] = uuid.split('-');
        return `${s1}-${s2}-${s3}-${s4}-${s5}` as const;
    }

    async postToTwitter(message: string) {
        // Initialize Twitter service if enabled
        let twitterService: TwitterService | undefined;
        try {
            elizaLogger.log(
                "Configuring Twitter service for trade notifications..."
            );
            const twitterConfig = TwitterConfigSchema.parse({
                enabled: this.runtime.getSetting("TWITTER_ENABLED") === "true",
                username: this.runtime.getSetting("TWITTER_USERNAME"),
                dryRun: false,
            });

            if (twitterConfig.enabled && this.runtime) {
                elizaLogger.log("Starting Twitter client initialization...");
                const twitterClient = null;
                twitterService = new TwitterService(twitterClient, twitterConfig);

                // Add delay after initialization
                await new Promise((resolve) => setTimeout(resolve, 5000));

                elizaLogger.log("Twitter service initialized successfully", {
                    username: twitterConfig.username,
                    dryRun: twitterConfig.dryRun,
                });
            }
        } catch (error) {
            elizaLogger.error("Failed to initialize Twitter service:", error);
        }

    }

    /**
     * Executes a buy decision for a token
     * @param tokenAddress - Address of the token to buy
     * @param amountToBuy - Amount of tokens to buy
     * @param buy_recommender_id - ID of the recommender for the buy
     * @param tokenProvider - Token provider for the token
     * @param retries - Number of retries for the buy
     * @param delayMs - Delay in milliseconds between retries
     * @returns Buy details
     */
    private async executeBuyDecision(
        tokenAddress: string,
        amountToBuy: number,
        buy_recommender_id: string | null,
        tokenProvider: TokenProvider,
        retries = 3,
        delayMs = 2000
    ) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // Do not buy if we already have a position
                if (this.runningProcesses.has(tokenAddress)) {
                    elizaLogger.log(`Skipping buy for ${tokenAddress} - already holding position`);
                    return null;
                }

                const availableCapital = await this.walletProvider.getAvailableCapital();
                const amountToBuy = this.calculatePositionSize(availableCapital);
                const userId = this.formatUUID(buy_recommender_id || uuidv4());
                const agentId = this.formatUUID(this.runtime.agentId || uuidv4());
                const roomId = this.formatUUID(this.runtime.getSetting("ROOM_ID") || uuidv4());

                const swapMessage: SwapMessage = {
                    tokenInAddress: this.baseMint.toBase58(),
                    tokenOutAddress: tokenAddress,
                    amount: amountToBuy,
                    userId,
                    agentId,
                    content: {
                        type: "swap",
                        text: `Swap ${amountToBuy} ${tokenAddress} for ${this.baseMint.toBase58()}`,
                        data: {
                            tokenInAddress: tokenAddress,
                            tokenOutAddress: this.baseMint.toBase58(),
                            amount: amountToBuy
                        }
                    },
                    roomId
                };
                elizaLogger.log(`swap message: ${swapMessage}`);

                // Execute swap with autoExecute enabled
                const result = await this.swapProvider.get(this.runtime, swapMessage);

                if (!result.executed) {
                    elizaLogger.error(`Swap execution failed for ${tokenAddress}`);
                    return false;
                }

                // Add to monitored tokens
                this.monitoredTokens.add(tokenAddress);

                const buyDetails: BuyDetails = {
                    buy_amount: amountToBuy,
                    buy_recommender_id,
                };
                const buyTimeStamp = new Date().toISOString();
                const processedData = await tokenProvider.getProcessedTokenData();

                // Update buy details in the database
                const buyDetailsData = await this.updateBuyDetails(
                    tokenAddress,
                    buy_recommender_id,
                    buyTimeStamp,
                    buyDetails,
                    true, // isSimulation
                    tokenProvider,
                    processedData
                );

                elizaLogger.log("Buy order executed successfully", buyDetailsData);

                // Add to running processes
                this.runningProcesses.add(tokenAddress);

                // Update airtable status
                await this.updateAirtableStatus(tokenAddress, "Holding");

                elizaLogger.log(`Buy executed successfully on attempt ${attempt}`);
                return buyDetailsData;
            } catch (error) {
                elizaLogger.error(
                    `Attempt ${attempt} failed: Error executing buy for ${tokenAddress}:`,
                    error
                );
                if (attempt < retries) {
                    elizaLogger.log(`Retrying buy in ${delayMs} ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else {
                    elizaLogger.error("All buy attempts failed.");
                    throw error;
                }
            }

        }
    }

    private async updateBuyDetails(
        tokenAddress: string,
        recommenderId: string,
        buyTimeStamp: string,
        buyDetails: BuyDetails,
        isSimulation: boolean,
        tokenProvider: TokenProvider,
        processedData: ProcessedTokenData
    ) {
        const recommender = await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
            recommenderId
        );

        const prices = await this.walletProvider.fetchPrices(null);
        const solPrice = prices.solana.usd;
        const buySol = buyDetails.buy_amount / parseFloat(solPrice);
        const buy_value_usd = buyDetails.buy_amount * processedData.tradeData.price;

        const marketCap = processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity = processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;
        const buy_price = processedData.tradeData.price;

        const buyDetailsData = {
            buy_price,
            buy_timeStamp: buyTimeStamp,
            buy_amount: buyDetails.buy_amount,
            spent_sol: buySol,
            buy_value_usd,
            buy_market_cap: marketCap,
            buy_liquidity: liquidity,
            buy_recommender_id: buyDetails.buy_recommender_id || null,
            initial_market_cap: buyDetails.initial_market_cap || marketCap,
        };

        // Create new trade performance record
        await this.trustScoreDb.addTradePerformance(
            {
                token_address: tokenAddress,
                recommender_id: recommender.id,
                buy_price: buyDetailsData.buy_price,
                buy_timeStamp: buyDetailsData.buy_timeStamp,
                buy_amount: buyDetailsData.buy_amount,
                buy_sol: buyDetailsData.spent_sol,
                buy_value_usd: buyDetailsData.buy_value_usd,
                buy_market_cap: buyDetailsData.buy_market_cap,
                buy_liquidity: buyDetailsData.buy_liquidity,
                last_updated: new Date().toISOString(),
                rapidDump: false,
                // Add required sell fields with null values
                sell_price: null,
                sell_timeStamp: null,
                sell_amount: null,
                received_sol: null,
                sell_value_usd: null,
                profit_usd: null,
                profit_percent: null,
                sell_market_cap: null,
                market_cap_change: null,
                sell_liquidity: null,
                liquidity_change: null
            },
            isSimulation
        );

        // Update token balance
        const oldBalance = this.trustScoreDb.getTokenBalance(tokenAddress) || 0;
        const tokenBalance = oldBalance + buyDetails.buy_amount;
        this.trustScoreDb.updateTokenBalance(tokenAddress, tokenBalance);

        // Record transaction
        const hash = Math.random().toString(36).substring(7);
        const transaction = {
            tokenAddress,
            type: "buy" as "buy" | "sell",
            transactionHash: hash,
            amount: buyDetails.buy_amount,
            price: processedData.tradeData.price,
            isSimulation: true,
            timestamp: new Date().toISOString(),
        };
        this.trustScoreDb.addTransaction(transaction);

        // Update backend
        await this.updateTradeInBe(
            tokenAddress,
            recommender.id,
            recommender.telegramId,
            buyDetailsData,
            tokenBalance,
            'buy'
        );

        return buyDetailsData;
    }

    async executeSellDecision(decision: SellDecision, retries = 3, delayMs = 2000) {
        const { tokenPerformance, amountToSell, sell_recommender_id } = decision;
        const tokenAddress = tokenPerformance.tokenAddress;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                elizaLogger.log(
                    `Executing sell for token ${tokenPerformance.symbol}: ${amountToSell}`
                );

                // Update the sell details
                const sellDetails: SellDetails = {
                    sell_amount: amountToSell,
                    sell_recommender_id: sell_recommender_id,
                };
                const sellTimeStamp = new Date().toISOString();
                const tokenProvider = new TokenProvider(
                    tokenAddress,
                    this.walletProvider,
                    this.runtime.cacheManager
                );

                // Update sell details in the database
                const sellDetailsData = await this.updateSellDetails(
                    tokenAddress,
                    sell_recommender_id,
                    sellTimeStamp,
                    sellDetails,
                    true, // isSimulation
                    tokenProvider
                );

                elizaLogger.log(
                    "Sell order executed successfully",
                    sellDetailsData
                );

                // check if balance is zero and remove token from running processes
                const balance = this.trustScoreDb.getTokenBalance(tokenAddress);
                if (balance === 0) {
                    this.runningProcesses.delete(tokenAddress);
                }

                // Update Airtable status
                await this.updateAirtableStatus(tokenAddress, "Bought and Sold");

                elizaLogger.log(`Sell executed successfully on attempt ${attempt}`);
                return sellDetailsData;
            } catch (error) {
                elizaLogger.error(
                    `Attempt ${attempt} failed: Error executing sell for ${tokenAddress}:`,
                    error
                );
                if (attempt < retries) {
                    elizaLogger.log(`Retrying sell in ${delayMs} ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else {
                    elizaLogger.error("All sell attempts failed.");
                    throw error;
                }
            }
        }
    }

    async updateSellDetails(
        tokenAddress: string,
        recommenderId: string,
        sellTimeStamp: string,
        sellDetails: SellDetails,
        isSimulation: boolean,
        tokenProvider: TokenProvider
    ) {
        const recommender = await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
            recommenderId
        );
        const processedData: ProcessedTokenData = await tokenProvider.getProcessedTokenData();
        const prices = await this.walletProvider.fetchPrices(null);
        const solPrice = prices.solana.usd;
        const sellSol = sellDetails.sell_amount / parseFloat(solPrice);
        const sell_value_usd = sellDetails.sell_amount * processedData.tradeData.price;

        const trade = await this.trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            recommender.id,
            isSimulation
        );

        const marketCap = processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity = processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;
        const sell_price = processedData.tradeData.price;
        const profit_usd = sell_value_usd - trade.buy_value_usd;
        const profit_percent = (profit_usd / trade.buy_value_usd) * 100;

        const sellDetailsData = {
            sell_price,
            sell_timeStamp: sellTimeStamp,
            sell_amount: sellDetails.sell_amount,
            received_sol: sellSol,
            sell_value_usd,
            profit_usd,
            profit_percent,
            sell_market_cap: marketCap,
            market_cap_change: marketCap - trade.buy_market_cap,
            sell_liquidity: liquidity,
            liquidity_change: liquidity - trade.buy_liquidity,
            rapidDump: await this.isRapidDump(tokenAddress, tokenProvider),
            sell_recommender_id: sellDetails.sell_recommender_id || null,
        };

        // Update database records
        this.trustScoreDb.updateTradePerformanceOnSell(
            tokenAddress,
            recommender.id,
            trade.buy_timeStamp,
            sellDetailsData,
            isSimulation
        );

        // Update token balance
        const oldBalance = this.trustScoreDb.getTokenBalance(tokenAddress);
        const tokenBalance = oldBalance - sellDetails.sell_amount;
        this.trustScoreDb.updateTokenBalance(tokenAddress, tokenBalance);

        // Record transaction
        const hash = Math.random().toString(36).substring(7);
        const transaction = {
            tokenAddress,
            type: "sell" as "buy" | "sell",
            transactionHash: hash,
            amount: sellDetails.sell_amount,
            price: processedData.tradeData.price,
            isSimulation: true,
            timestamp: new Date().toISOString(),
        };
        this.trustScoreDb.addTransaction(transaction);

        // Update backend
        await this.updateTradeInBe(
            tokenAddress,
            recommender.id,
            recommender.telegramId,
            sellDetailsData,
            tokenBalance,
            'sell'  // Add tradeType parameter
        );

        return sellDetailsData;
    }

    private async isRapidDump(
        tokenAddress: string,
        tokenProvider: TokenProvider
    ): Promise<boolean> {
        const processedData: ProcessedTokenData = await tokenProvider.getProcessedTokenData();
        elizaLogger.log(`Fetched processed token data for token: ${tokenAddress}`);
        return processedData.tradeData.trade_24h_change_percent < -50;
    }

    private async updateTradeInBe(
        tokenAddress: string,
        recommenderId: string,
        username: string,
        data: any,
        balanceLeft: number,
        tradeType: 'buy' | 'sell',
        retries = 3,
        delayMs = 2000
    ) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await fetch(
                    `${this.backendUrl}/api/updaters/updateTradePerformance`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            tokenAddress,
                            tradeData: data,
                            recommenderId,
                            username,
                            isSimulation: true,
                            balanceLeft,
                            tradeType,
                        }),
                    }
                );

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return;
            } catch (error) {
                elizaLogger.error(
                    `Attempt ${attempt} failed: Error updating ${tradeType} in backend`,
                    error
                );
                if (attempt < retries) {
                    elizaLogger.log(`Retrying in ${delayMs} ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else {
                    elizaLogger.error("All attempts failed.");
                    throw error;
                }
            }
        }
    }


    async evaluateTradingOpportunity(tokenAddress: string): Promise<{ buyPercentage: number, sellPercentage: number }> {
        const tokenProvider = new TokenProvider(
            tokenAddress,
            this.walletProvider,
            this.runtime.cacheManager
        );

        const strategyEvaluator = new TradingStrategyEvaluator(
            tokenProvider,
            this.runtime
        );

        const allStrategyResults: BacktestResult[] = await strategyEvaluator.evaluateAllStrategies(tokenAddress);
        elizaLogger.log("All strategy results count---------------", allStrategyResults.length);

        // Calculate weighted average of all strategy results
        const buySignals = allStrategyResults.filter(r => r.signals.shouldBuy).length;
        const sellSignals = allStrategyResults.filter(r => r.signals.shouldSell).length;

        // Calculate percentage of strategies signaling buy/sell
        const totalStrategies = allStrategyResults.length;
        const buyPercentage = (buySignals / totalStrategies) * 100;
        const sellPercentage = (sellSignals / totalStrategies) * 100;

        elizaLogger.log(`Buy signals: ${buySignals}/${totalStrategies} (${buyPercentage}%)`);
        elizaLogger.log(`Sell signals: ${sellSignals}/${totalStrategies} (${sellPercentage}%)`);

        return { buyPercentage, sellPercentage };
    }


    private getStrategyWeight(strategyResult: BacktestResult): number {
        elizaLogger.log("getStrategyWeight---------------");
        // Weight based on strategy performance metrics
        const winRate = strategyResult.metrics.winRate || 0;
        const profitFactor = strategyResult.totalProfit > 0 ? 1.2 : 0.8;
        const tradeCount = strategyResult.trades.length;

        // More trades = more reliable backtest
        const tradeCountFactor = Math.min(tradeCount / 10, 1); // Max out at 10 trades

        elizaLogger.log("end getStrategyWeight---------------");
        return winRate * profitFactor * tradeCountFactor;
    }

    private calculateTrustFromBacktest(backtest: BacktestResult): number {
        // Implement logic to convert backtest results to trust score
        const winRateWeight = 0.4;
        const profitWeight = 0.6;

        const winRateScore = backtest.metrics.winRate * 100;
        const profitScore = Math.min(backtest.totalProfit, 100);

        return (winRateScore * winRateWeight) + (profitScore * profitWeight);
    }


    async startTradePlan(): Promise<TradePlan[]> {
        elizaLogger.log(`startTradePlan started----------------`);

        // Check if already running
        if (this.isRunning) {
            elizaLogger.log('Trade plan already running, skipping...');
            return [];
        }

        const tradePlans: TradePlan[] = [];

        try {
            this.isRunning = true;

            // Get new tokens from Airtable
            const records = await this.airtableBase(this.config.AIRTABLE_TABLE_NAME)
            .select({
                view: "New Prospects",
                maxRecords: 1000,
                fields: ["Mint", "Name", "Symbol", "Uri"]
            })
            .all();
            elizaLogger.log(`pumpfun new tokens retrieved count: ${records.length}`);

            // Update last check time
            this.lastCheck = new Date();
            elizaLogger.log(`startTradePlan lastCheck: ${this.lastCheck}`);

            // Process new tokens
            for (const record of records) {
                const tokenAddress = record.get('Mint') as string;
                if (!this.monitoredTokens.has(tokenAddress)) {
                    this.monitoredTokens.add(tokenAddress);
                    elizaLogger.log(`New token found for monitoring: ${tokenAddress}`);
                }
            }

            // Evaluate all monitored tokens
            for (const tokenAddress of this.monitoredTokens) {
                elizaLogger.log(`tokenAddress--- ${tokenAddress}`);
                const tokenPerformance = await this.trustScoreDb.getTokenPerformance(tokenAddress);
                elizaLogger.log(`tokenPerformance ${tokenPerformance}`);

                const trustEvaluation = await this.evaluateTradingOpportunity(
                    tokenAddress
                );
                elizaLogger.log(`trustEvaluation ${trustEvaluation}`);

                //const marketConditions = await this.evaluateMarketConditions(tokenAddress);
                //elizaLogger.log(`marketConditions ${marketConditions}`);

                const tradePlan = await this.generateTradePlan(
                    tokenAddress,
                    trustEvaluation
                );
                elizaLogger.log(`tradePlan ${tradePlan}`);

                elizaLogger.log(`pushing trade plan for ${tokenAddress}`);
                tradePlans.push(tradePlan);

                // If conditions are perfect, execute buy
                elizaLogger.log(`shouldExecuteBuy ${this.shouldExecuteBuy(tradePlan)}`);
                if (this.shouldExecuteBuy(tradePlan)) {
                    elizaLogger.log(`executing buy for ${tokenAddress}`);
                    const tokenProvider = new TokenProvider(
                        tokenAddress,
                        this.walletProvider,
                        this.runtime.cacheManager
                    );
                    elizaLogger.log(`buy 0.1 SOL worth of ${tokenAddress}`);
                    await this.executeBuyDecision(
                        tokenAddress,
                        0.1,
                        "TRADING_BOT_STRATEGY",
                        tokenProvider
                    );
                }
            }
        } catch (error) {
            elizaLogger.error("Error fetching from Airtable:", error);
        } finally {
            // Release lock even if there's an error
            this.isRunning = false;
            elizaLogger.log('Trade plan execution completed.');
        }

        return tradePlans;
    }

    private shouldExecuteBuy(tradePlan: TradePlan): boolean {
        return tradePlan.action === 'buy' &&
               tradePlan.reasoning.length > 0;
    }

    private shouldExecuteSell(tradePlan: TradePlan): boolean {
        return tradePlan.action === 'sell' &&
               tradePlan.reasoning.length > 0;
    }

    private async evaluateMarketConditions(tokenAddress: string) {
        // Implement market condition evaluation
        return {
            priceMovement: 0,
            volume: 0,
            liquidity: 0,
            timeSinceListing: 0
        };
    }

    private async generateTradePlan(
        tokenAddress: string,
        trustEvaluation: { buyPercentage: number, sellPercentage: number }
    ): Promise<TradePlan> {
        elizaLogger.log(`generateTradePlan started`);
        // Define thresholds
        const BUY_THRESHOLD = Number(this.runtime.getSetting("TRADING_STRATEGY_BUY_THRESHOLD")) || 50;
        const SELL_THRESHOLD = Number(this.runtime.getSetting("TRADING_STRATEGY_SELL_THRESHOLD")) || 50;

        let action: 'buy' | 'sell' | 'hold' = 'hold';
        let reasoning: string[] = [];

        elizaLogger.log(`trustEvaluation.buyPercentage ${trustEvaluation.buyPercentage}`);
        elizaLogger.log(`trustEvaluation.sellPercentage ${trustEvaluation.sellPercentage}`);
        if (trustEvaluation.buyPercentage >= BUY_THRESHOLD) {
            action = 'buy';
            reasoning.push(`${trustEvaluation.buyPercentage}% of strategies suggest buying`);
        } else if (trustEvaluation.sellPercentage >= SELL_THRESHOLD) {
            action = 'sell';
            reasoning.push(`${trustEvaluation.sellPercentage}% of strategies suggest selling`);
        } else {
            reasoning.push('No strong signals detected');
        }
        elizaLogger.log(`action: ${action}`);
        elizaLogger.log(`reasoning: ${reasoning}`);

        const response: TradePlan = {
            tokenAddress: tokenAddress,
            action,
            reasoning
        };
        elizaLogger.log(`generateTradePlan response ${response}`);
        elizaLogger.log(`generateTradePlan ended`);
        return response;
    }
}

class TradingStrategyEvaluator {
    private strategies = [
        {
            name: 'CCI',
            type: StrategyType.MOMENTUM,
            params: {},
            indicator: (prices: number[]) => new CCI({
                high: prices,
                low: prices,
                close: prices,
                period: 20
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < -100,
                sellSignal: values[values.length - 1] > 100
            })
        },
        {
            name: 'RSI CLASSIC',
            type: StrategyType.MOMENTUM,
            params: {},
            indicator: (prices: number[]) => new RSI({ values: prices, period: 14 }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < 30,
                sellSignal: values[values.length - 1] > 70
            })
        },
        {
            name: 'RATE OF CHANGE MOMENTUM',
            type: StrategyType.MOMENTUM,
            params: {},
            indicator: (prices: number[]) => new ROC({ values: prices, period: 12 }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 0,
                sellSignal: values[values.length - 1] < 0
            })
        }
    ];

    private trendStrategies = [
        {
            name: 'TREND STRENGTH ADX',
            type: StrategyType.TREND,
            params: {},
            indicator: (prices: number[]) => new ADX({
                high: prices,
                low: prices,
                close: prices,
                period: 14
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 25,
                sellSignal: values[values.length - 1] < 20
            })
        },
        {
            name: 'FORCE INDEX TREND',
            type: StrategyType.TREND,
            params: {},
            indicator: (prices: number[], volume: number[]) => new ForceIndex({
                close: prices,
                volume: volume,
                period: 13
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 0,
                sellSignal: values[values.length - 1] < 0
            })
        },
        {
            name: 'AWESOME OSCILLATOR',
            type: StrategyType.TREND,
            params: {},
            indicator: (prices: number[]) => new AwesomeOscillator({
                high: prices,
                low: prices,
                fastPeriod: 5,
                slowPeriod: 34
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 0 && values[values.length - 2] < 0,
                sellSignal: values[values.length - 1] < 0 && values[values.length - 2] > 0
            })
        }
    ]

    /**
     * Initializes the TradingStrategyEvaluator with a token provider and runtime.
     *
     * @param tokenProvider The token provider instance
     * @param runtime The runtime environment
     */
    constructor(
        private tokenProvider: TokenProvider,
        private runtime: IAgentRuntime
    ) {}

    /**
     * Evaluates all trading strategies for a given token address.
     *
     * @param tokenAddress The address of the token to evaluate strategies for
     * @returns An array of BacktestResult objects containing performance metrics for each strategy
     */
    async evaluateAllStrategies(tokenAddress: string): Promise<BacktestResult[]> {
        try {
            // Get trade data
            const tokenTradeData = await this.tokenProvider.fetchTokenTradeData(tokenAddress);

            const prices = [
                tokenTradeData.history_30m_price,
                tokenTradeData.history_1h_price,
                tokenTradeData.history_2h_price,
                tokenTradeData.history_4h_price,
                tokenTradeData.history_8h_price,
                tokenTradeData.history_24h_price
            ];

            const volumes = [
                tokenTradeData.volume_30m,
                tokenTradeData.volume_1h,
                tokenTradeData.volume_2h,
                tokenTradeData.volume_4h,
                tokenTradeData.volume_8h,
                tokenTradeData.volume_24h
            ];

            // Run backtest for each strategy
            const momentumResults = await Promise.all(this.strategies
                .filter(s => s.type.toUpperCase() === 'MOMENTUM')
                .map(strategy => this.backtestMomentumStrategy2(strategy, tokenTradeData, prices, volumes))
            );
            const trendResults = await Promise.all(this.trendStrategies
                .filter(s => s.type.toUpperCase() === 'TREND')
                .map(strategy => this.backtestTrendStrategy2(strategy, tokenTradeData, prices, volumes))
            );
            elizaLogger.info(`trendResults length: ${trendResults.length}`);
            elizaLogger.info(`trendResults[0].signals: ${trendResults[0].signals}`);
            const results: BacktestResult[] = [...momentumResults, ...trendResults].filter(result => result !== null);

            // Generate report before returning
            if (results.length > 0) {
                elizaLogger.info('=== STRATEGY EVALUATION REPORT ===');
                elizaLogger.info(`Token: ${tokenAddress}`);
                elizaLogger.info(`Price: ${tokenTradeData.price}`);

                results.forEach(result => {
                    elizaLogger.info(`${result.strategyName}: Buy=${result.signals.shouldBuy} Sell=${result.signals.shouldSell}`);
                });

                const buySignals = results.filter(r => r.signals.shouldBuy).length;
                const sellSignals = results.filter(r => r.signals.shouldSell).length;

                elizaLogger.info(`Summary: Buy=${buySignals}/${results.length} Sell=${sellSignals}/${results.length}`);
            }
            return results;
        } catch (error) {
            elizaLogger.error(`Error evaluating strategies for token ${tokenAddress}: ${error}`);
            throw error;
        }
    }

    /**
     * Backtests a trend following strategy using historical price data.
     *
     * @param strategy The trend strategy configuration to test
     * @param tokenTradeData Historical price and trade data for the token
     * @returns A BacktestResult object containing performance metrics
     *
     * The strategy uses exponential moving average (EMA) crossovers:
     * 1. Calculates short and long period EMAs
     * 2. Generates buy signals on bullish crossovers (short EMA crosses above long EMA)
     * 3. Generates sell signals on bearish crossovers (short EMA crosses below long EMA)
     * 4. Tracks trades and calculates profit/loss
     *
     * Strategy parameters include:
     * - shortEMA: Period for short-term EMA (default 9)
     * - longEMA: Period for long-term EMA (default 21)
     */
    private async backtestTrendStrategy(strategy: TradingStrategy, tokenTradeData: TokenTradeData, prices: number[], volumes: number[]    ): Promise<BacktestResult> {
        const lastTradeTime = tokenTradeData.last_trade_unix_time;
        const timestamps = prices.map((_, index) => {
            const intervals = [0.5, 1, 2, 4, 6, 8, 12, 24]; // hours
            const hoursAgo = intervals[index];
            return lastTradeTime - (hoursAgo * 60 * 60 * 1000);
        });
        let signals = {
            shouldBuy: false,
            shouldSell: false
        };
        let shortEMA, longEMA;
        elizaLogger.log("strategy name for trend------------------------------- " + strategy.name);
        switch(strategy.name.toUpperCase()) {
            case 'EMA_Cross':
                elizaLogger.log("1 trend-------------------------------------------------------");
                shortEMA = this.calculateEMA(prices, strategy.params.shortEMA || 9);
                longEMA = this.calculateEMA(prices, strategy.params.longEMA || 21);
                signals = {
                    shouldBuy: shortEMA[shortEMA.length - 1] > longEMA[longEMA.length - 1] &&
                              shortEMA[shortEMA.length - 2] <= longEMA[longEMA.length - 2],  // Golden Cross
                    shouldSell: shortEMA[shortEMA.length - 1] < longEMA[longEMA.length - 1] &&
                               shortEMA[shortEMA.length - 2] >= longEMA[longEMA.length - 2]  // Death Cross
                };
                elizaLogger.log("1 signals-------------------------------------------------------" + signals);
                break;
            case 'TREND STRENGTH ADX':
                elizaLogger.log("2 trend-------------------------------------------------------");
                const adx = new ADX({
                    high: prices,
                    low: prices,
                    close: prices,
                    period: strategy.params.adxPeriod || 14
                }).getResult();
                signals = {
                    shouldBuy: adx[adx.length - 1] > 25,  // Strong trend when ADX > 25
                    shouldSell: adx[adx.length - 1] < 20   // Weak trend when ADX < 20
                };
                elizaLogger.log("2 signals-------------------------------------------------------" + signals);
                break;
            case 'FORCE INDEX TREND':
                elizaLogger.log("3 trend-------------------------------------------------------");
                const forceIndex = new ForceIndex({
                    close: prices,
                    volume: volumes,
                    period: strategy.params.forcePeriod || 13
                }).getResult();
                signals = {
                    shouldBuy: forceIndex[forceIndex.length - 1] > 0,  // Positive force index
                    shouldSell: forceIndex[forceIndex.length - 1] < 0  // Negative force index
                };
                elizaLogger.log("3 signals-------------------------------------------------------" + signals);
                break;
            case 'AWESOME OSCILLATOR':
                elizaLogger.log("4 trend-------------------------------------------------------");
                const ao = new AwesomeOscillator({
                    high: prices,
                    low: prices,
                    fastPeriod: strategy.params.aoFast || 5,
                    slowPeriod: strategy.params.aoSlow || 34
                }).getResult();
                signals = {
                    shouldBuy: ao[ao.length - 1] > 0 && ao[ao.length - 2] < 0,  // Crosses above zero
                    shouldSell: ao[ao.length - 1] < 0 && ao[ao.length - 2] > 0   // Crosses below zero
                };
                elizaLogger.log("4 signals-------------------------------------------------------" + signals);
                break;
            case 'RATE OF CHANGE MOMENTUM':
                elizaLogger.log("Rate of Change Momentum trend-------------------------------------------------------");
                const roc = new ROC({
                    values: prices,
                    period: strategy.params.rocPeriod || 12
                }).getResult();
                signals = {
                    shouldBuy: roc[roc.length - 1] > 0,
                    shouldSell: roc[roc.length - 1] < 0
                };
                elizaLogger.log("Rate of Change Momentum signals-------------------------------------------------------" + signals);
                break;
            case 'BOLLINGER BANDS':
                elizaLogger.log("Bollinger Bands trend-------------------------------------------------------");
                const bb = new BollingerBands({
                    values: prices,
                    period: strategy.params.bbPeriod || 20,
                    stdDev: strategy.params.bbStdDev || 2
                }).getResult();
                signals = {
                    shouldBuy: prices[prices.length - 1] < bb.lower[bb.lower.length - 1],
                    shouldSell: prices[prices.length - 1] > bb.upper[bb.upper.length - 1]
                };
                elizaLogger.log("Bollinger Bands signals-------------------------------------------------------" + signals);
                break;
            case 'ICHIMOKU CLOUD':
                elizaLogger.log("Ichimoku Cloud trend-------------------------------------------------------");
                const ichimoku = new IchimokuCloud({
                    high: prices,
                    low: prices,
                    conversionPeriod: strategy.params.conversionPeriod || 9,
                    basePeriod: strategy.params.basePeriod || 26,
                    spanPeriod: strategy.params.spanPeriod || 52,
                    displacement: strategy.params.displacement || 26
                }).getResult();
                signals = {
                    shouldBuy: ichimoku.spanA[ichimoku.spanA.length - 1] > ichimoku.spanB[ichimoku.spanB.length - 1],
                    shouldSell: ichimoku.spanA[ichimoku.spanA.length - 1] < ichimoku.spanB[ichimoku.spanB.length - 1]
                };
                elizaLogger.log("Ichimoku Cloud signals-------------------------------------------------------" + signals);
                break;
            case 'VWAP':
                elizaLogger.log("VWAP trend-------------------------------------------------------");
                const vwap = new VWAP({
                    high: prices,
                    low: prices,
                    close: prices,
                    volume: volumes
                }).getResult();
                signals = {
                    shouldBuy: prices[prices.length - 1] < vwap[vwap.length - 1],
                    shouldSell: prices[prices.length - 1] > vwap[vwap.length - 1]
                };
                elizaLogger.log("VWAP signals-------------------------------------------------------" + signals);
                break;
            case 'PSAR':
                elizaLogger.log("PSAR trend-------------------------------------------------------");
                const psar = new PSAR({
                    high: prices,
                    low: prices,
                    step: strategy.params.psarStep || 0.02,
                    max: strategy.params.psarMax || 0.2
                }).getResult();
                signals = {
                    shouldBuy: prices[prices.length - 1] > psar[psar.length - 1],
                    shouldSell: prices[prices.length - 1] < psar[psar.length - 1]
                };
                elizaLogger.log("PSAR signals-------------------------------------------------------" + signals);
                break;
            default:
                elizaLogger.log("default trend-------------------------------------------------------");
                break;
        }

        const response: BacktestResult = {
            strategyName: strategy.name,
            signals: {
                shouldBuy: signals.shouldBuy ? 1 : 0,  // Convert boolean to number
                shouldSell: signals.shouldSell ? 1 : 0  // Convert boolean to number
            },
            metrics: {
                winRate: signals.shouldBuy ? 1 : 0,  // If we have a buy signal, consider it a potential win
                averageProfit: 0
            },
        };
        elizaLogger.log("backtestTrendStrategy response: " + response);
        return response;
    }

    private async backtestTrendStrategy2(
        strategy: TradingStrategy,
        tokenTradeData: TokenTradeData,
        prices: number[],
        volumes: number[]
      ): Promise<BacktestResult> {
        // Logging the start of the backtest.
        elizaLogger.log(`Starting backtestTrendStrategy for strategy: ${strategy.name}`);

        // Define initial capital.
        const initialCapital = 1000;
        let capital = initialCapital;
        let position: { entryIndex: number; entryPrice: number } | null = null;
        const trades: SimulatedTrade[] = [];

        // Choose an appropriate lookback period based on the strategy.
        let lookbackPeriod = 1;
        switch (strategy.name.toUpperCase()) {
          case 'EMA_CROSS':
            lookbackPeriod = Math.max(strategy.params.shortEMA || 9, strategy.params.longEMA || 21);
            break;
          case 'TREND STRENGTH ADX':
            lookbackPeriod = strategy.params.adxPeriod || 14;
            break;
          case 'FORCE INDEX TREND':
            lookbackPeriod = strategy.params.forcePeriod || 13;
            break;
          case 'AWESOME OSCILLATOR':
            lookbackPeriod = Math.max(strategy.params.aoFast || 5, strategy.params.aoSlow || 34);
            break;
          case 'BOLLINGER BANDS':
            lookbackPeriod = strategy.params.bbPeriod || 20;
            break;
          case 'ICHIMOKU CLOUD':
            lookbackPeriod = Math.max(strategy.params.conversionPeriod || 9, strategy.params.basePeriod || 26, strategy.params.spanPeriod || 52);
            break;
          case 'VWAP':
            lookbackPeriod = 10; // a reasonable default
            break;
          case 'PSAR':
            lookbackPeriod = 1;
            break;
          case 'RATE OF CHANGE MOMENTUM':
            lookbackPeriod = strategy.params.rocPeriod || 12;
            break;
          default:
            lookbackPeriod = 10;
            break;
        }

        // Loop over historical data starting from the lookback period.
        for (let i = lookbackPeriod; i < prices.length; i++) {
          let signal: "buy" | "sell" | "hold" = "hold";

          // Calculate signals based on the strategy.
          switch (strategy.name.toUpperCase()) {
            case 'EMA_CROSS': {
              const shortEMA = this.calculateEMA(prices.slice(0, i + 1), strategy.params.shortEMA || 9);
              const longEMA = this.calculateEMA(prices.slice(0, i + 1), strategy.params.longEMA || 21);
              if (shortEMA.length >= 2 && longEMA.length >= 2) {
                if (shortEMA[shortEMA.length - 1] > longEMA[longEMA.length - 1] &&
                    shortEMA[shortEMA.length - 2] <= longEMA[longEMA.length - 2]) {
                  signal = "buy";
                } else if (shortEMA[shortEMA.length - 1] < longEMA[longEMA.length - 1] &&
                           shortEMA[shortEMA.length - 2] >= longEMA[longEMA.length - 2]) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'TREND STRENGTH ADX': {
              const adx = new ADX({
                high: prices.slice(0, i + 1),
                low: prices.slice(0, i + 1),
                close: prices.slice(0, i + 1),
                period: strategy.params.adxPeriod || 14,
              }).getResult();
              if (adx.length > 0) {
                const currentAdx = adx[adx.length - 1];
                if (currentAdx > 25) {
                  signal = "buy";
                } else if (currentAdx < 20) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'FORCE INDEX TREND': {
              const forceIndex = new ForceIndex({
                close: prices.slice(0, i + 1),
                volume: volumes.slice(0, i + 1),
                period: strategy.params.forcePeriod || 13,
              }).getResult();
              if (forceIndex.length > 0) {
                if (forceIndex[forceIndex.length - 1] > 0) {
                  signal = "buy";
                } else if (forceIndex[forceIndex.length - 1] < 0) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'AWESOME OSCILLATOR': {
              const ao = new AwesomeOscillator({
                high: prices.slice(0, i + 1),
                low: prices.slice(0, i + 1),
                fastPeriod: strategy.params.aoFast || 5,
                slowPeriod: strategy.params.aoSlow || 34,
              }).getResult();
              if (ao.length >= 2) {
                if (ao[ao.length - 1] > 0 && ao[ao.length - 2] < 0) {
                  signal = "buy";
                } else if (ao[ao.length - 1] < 0 && ao[ao.length - 2] > 0) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'BOLLINGER BANDS': {
              const bb = new BollingerBands({
                values: prices.slice(0, i + 1),
                period: strategy.params.bbPeriod || 20,
                stdDev: strategy.params.bbStdDev || 2,
              }).getResult();
              if (bb && bb.lower && bb.upper && bb.lower.length > 0 && bb.upper.length > 0) {
                if (prices[i] < bb.lower[bb.lower.length - 1]) {
                  signal = "buy";
                } else if (prices[i] > bb.upper[bb.upper.length - 1]) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'ICHIMOKU CLOUD': {
              const ichimoku = new IchimokuCloud({
                high: prices.slice(0, i + 1),
                low: prices.slice(0, i + 1),
                conversionPeriod: strategy.params.conversionPeriod || 9,
                basePeriod: strategy.params.basePeriod || 26,
                spanPeriod: strategy.params.spanPeriod || 52,
                displacement: strategy.params.displacement || 26,
              }).getResult();
              if (ichimoku && ichimoku.spanA && ichimoku.spanB) {
                const len = ichimoku.spanA.length;
                if (len > 0) {
                  if (ichimoku.spanA[len - 1] > ichimoku.spanB[len - 1]) {
                    signal = "buy";
                  } else if (ichimoku.spanA[len - 1] < ichimoku.spanB[len - 1]) {
                    signal = "sell";
                  }
                }
              }
              break;
            }
            case 'VWAP': {
              const vwap = new VWAP({
                high: prices.slice(0, i + 1),
                low: prices.slice(0, i + 1),
                close: prices.slice(0, i + 1),
                volume: volumes.slice(0, i + 1),
              }).getResult();
              if (vwap && vwap.length > 0) {
                if (prices[i] < vwap[vwap.length - 1]) {
                  signal = "buy";
                } else if (prices[i] > vwap[vwap.length - 1]) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'PSAR': {
              const psar = new PSAR({
                high: prices.slice(0, i + 1),
                low: prices.slice(0, i + 1),
                step: strategy.params.psarStep || 0.02,
                max: strategy.params.psarMax || 0.2,
              }).getResult();
              if (psar && psar.length > 0) {
                if (prices[i] > psar[psar.length - 1]) {
                  signal = "buy";
                } else if (prices[i] < psar[psar.length - 1]) {
                  signal = "sell";
                }
              }
              break;
            }
            case 'RATE OF CHANGE MOMENTUM': {
              const roc = new ROC({
                values: prices.slice(0, i + 1),
                period: strategy.params.rocPeriod || 12,
              }).getResult();
              if (roc.length >= 2) {
                if (roc[roc.length - 1] > 0 && roc[roc.length - 2] <= 0) {
                  signal = "buy";
                } else if (roc[roc.length - 1] < 0 && roc[roc.length - 2] >= 0) {
                  signal = "sell";
                }
              }
              break;
            }
            default: {
              signal = "hold";
              break;
            }
          } // End switch

          // Simulate trade logic.
          if (!position && signal === "buy") {
            // Open a position at current price.
            position = { entryIndex: i, entryPrice: prices[i] };
            elizaLogger.log(`BUY signal at index ${i} (price: ${prices[i]})`);
          } else if (position && signal === "sell") {
            // Close position.
            const exitPrice = prices[i];
            const profit = exitPrice - position.entryPrice;
            capital += profit;
            trades.push({
              entryIndex: position.entryIndex,
              exitIndex: i,
              entryPrice: position.entryPrice,
              exitPrice: exitPrice,
              profit: profit,
            });
            elizaLogger.log(`SELL signal at index ${i} (price: ${exitPrice}). Trade profit: ${profit.toFixed(2)}`);
            position = null;
          }
          // Otherwise, hold.
        }

        // If a position remains open at the end, close it.
        if (position) {
          const exitPrice = prices[prices.length - 1];
          const profit = exitPrice - position.entryPrice;
          capital += profit;
          trades.push({
            entryIndex: position.entryIndex,
            exitIndex: prices.length - 1,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            profit: profit,
          });
          elizaLogger.log(`Closing open position at end (price: ${exitPrice}). Trade profit: ${profit.toFixed(2)}`);
          position = null;
        }

        // Compute performance metrics.
        const totalTrades = trades.length;
        const winningTrades = trades.filter(t => t.profit > 0).length;
        const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
        const averageProfit = totalTrades > 0 ? trades.reduce((sum, t) => sum + t.profit, 0) / totalTrades : 0;
        const cumulativeProfit = capital - initialCapital;

        elizaLogger.log(`Backtest for ${strategy.name} completed. Total trades: ${totalTrades}, Win rate: ${(winRate * 100).toFixed(2)}%, Average profit: ${averageProfit.toFixed(2)}, Cumulative profit: ${cumulativeProfit.toFixed(2)}`);

        // Build the backtest result.
        const response: BacktestResult = {
          strategyName: strategy.name,
          totalProfit: cumulativeProfit,
          trades: trades.map(t => ({
            type: "buy", // In this simplified model, we record only the entry price for each trade.
            price: t.entryPrice,
            timestamp: "", // Timestamps could be added if available.
            profit: t.profit,
          })),
          metrics: {
            winRate: winRate,
            averageProfit: averageProfit,
          },
          signals: {
            shouldBuy: totalTrades > 0 ? 1 : 0,
            shouldSell: 0,
          },
        };

        return response;
      }

    /**
     * Calculates the Relative Strength Index (RSI) for a given set of prices.
     *
     * @param prices The historical price data
     * @param period The period for RSI calculation (default is 14)
     * @returns An array of RSI values
     */
    private calculateRSI(prices: number[], period: number = 14): number[] {
        const rsi: number[] = [];
        const gains: number[] = [];
        const losses: number[] = [];

        // Calculate price changes
        for (let i = 1; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }

        // Calculate initial average gain and loss
        const avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
        const avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

        let prevAvgGain = avgGain;
        let prevAvgLoss = avgLoss;

        // Calculate RSI using Wilder's smoothing method
        for (let i = period; i < prices.length; i++) {
            const currentGain = gains[i - 1];
            const currentLoss = losses[i - 1];

            const smoothedAvgGain = (prevAvgGain * (period - 1) + currentGain) / period;
            const smoothedAvgLoss = (prevAvgLoss * (period - 1) + currentLoss) / period;

            prevAvgGain = smoothedAvgGain;
            prevAvgLoss = smoothedAvgLoss;

            const rs = smoothedAvgGain / smoothedAvgLoss;
            const currentRSI = 100 - (100 / (1 + rs));

            rsi.push(currentRSI);
        }

        return rsi;
    }

    /**
     * Calculates the Moving Average Convergence Divergence (MACD) for a given set of prices.
     *
     * @param prices The historical price data
     * @param fastPeriod The period for the fast moving average (default is 12)
     * @param slowPeriod The period for the slow moving average (default is 26)
     * @param signalPeriod The period for the signal line (default is 9)
     * @returns An object containing MACD values
     */
    private calculateMACD(
        prices: number[],
        fastPeriod: number = 12,
        slowPeriod: number = 26,
        signalPeriod: number = 9
    ): any {
        try {
            const macd = new MACD({
                values: prices,
                fastPeriod: fastPeriod,
                slowPeriod: slowPeriod,
                signalPeriod: signalPeriod,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            }).getResult();

            elizaLogger.log(`MACD Calculation - Fast: ${fastPeriod}, Slow: ${slowPeriod}, Signal: ${signalPeriod}`);

            return {
                MACD: macd.MACD,
                signal: macd.signal,
                histogram: macd.histogram,
                // For trading signals
                buySignal: macd.MACD[macd.MACD.length - 1] > macd.signal[macd.signal.length - 1],
                sellSignal: macd.MACD[macd.MACD.length - 1] < macd.signal[macd.signal.length - 1]
            };
        } catch (error) {
            elizaLogger.error('Error calculating MACD:', error);
            return {
                MACD: [],
                signal: [],
                histogram: [],
                buySignal: false,
                sellSignal: false
            };
        }
    }

    /**
     * Calculates the Exponential Moving Average (EMA) for a given set of prices.
     *
     * @param prices The historical price data
     * @param period The period for EMA calculation (default is 14)
     * @returns An array of EMA values
     */
    private calculateEMA(prices: number[], period: number = 14): number[] {
        try {
            const ema = new EMA({
                values: prices,
                period: period
            }).getResult();

            elizaLogger.log(`EMA Calculation - Period: ${period}, Result Length: ${ema.length}`);

            if (ema.length === 0) {
                elizaLogger.error('EMA calculation returned empty array');
                return [];
            }

            return ema;
        } catch (error) {
            elizaLogger.error('Error calculating EMA:', error);
            return [];
        }
    }

    /**
     * Backtests a momentum trading strategy using historical price data.
     *
     * @param strategy The momentum trading strategy configuration to test
     * @param tokenTradeData Historical price and trade data for the token
     * @returns A BacktestResult object containing performance metrics
     */
    private async backtestMomentumStrategy(strategy: TradingStrategy, tokenTradeData: TokenTradeData, prices: number[], volumes: number[]    ): Promise<BacktestResult> {
        elizaLogger.info("backtestMomentumStrategy tradeData: " + tokenTradeData);
        elizaLogger.log("backtestMomentumStrategy prices: " + prices);

        let signals = {
            shouldBuy: false,
            shouldSell: false
        }
        let macd, rsi;
        elizaLogger.log("strategy name for momentum------------------------------- " + strategy.name);
        switch(strategy.name) {
            case 'RSI CLASSIC':
                elizaLogger.log("1-------------------------------------------------------");
                rsi = this.calculateRSI(prices, strategy.params.rsiPeriod);
                elizaLogger.log("backtestMomentumStrategy rsi: " + rsi);
                signals = {
                    shouldBuy: rsi[rsi.length - 1] <= 30,    // Oversold condition - potential buy signal
                    shouldSell: rsi[rsi.length - 1] >= 70    // Overbought condition - potential sell signal
                };
                break;
            case 'MACD':
                elizaLogger.log("2-------------------------------------------------------");
                macd = this.calculateMACD(
                    prices,
                    strategy.params.macdFast,
                    strategy.params.macdSlow,
                    strategy.params.macdSignal
                );
                signals = {
                    shouldBuy: macd.buySignal,
                    shouldSell: macd.sellSignal
                };
                elizaLogger.log("backtestMomentumStrategy macd: " + macd);
                break;
            case 'RATE OF CHANGE MOMENTUM':
                elizaLogger.log("5-------------------------------------------------------");
                const roc = new ROC({
                    values: prices,
                    period: strategy.params.rocPeriod || 12
                }).getResult();
                signals = {
                    shouldBuy: roc[roc.length - 1] > 0 && roc[roc.length - 2] <= 0,
                    shouldSell: roc[roc.length - 1] < 0 && roc[roc.length - 2] >= 0
                };
                break;
            default:
                elizaLogger.log("default momentum-------------------------------------------------------");
                break;
        }
        elizaLogger.log("backtestMomentumStrategy strategyName: " + strategy.name);
        elizaLogger.log("backtestMomentumStrategy shouldBuy: " + signals.shouldBuy);
        elizaLogger.log("backtestMomentumStrategy shouldSell: " + signals.shouldSell);
        const response = {
            strategyName: strategy.name,
            signals: {
                shouldBuy: signals.shouldBuy ? 1 : 0,  // Convert boolean to number
                shouldSell: signals.shouldSell ? 1 : 0  // Convert boolean to number
            },
            metrics: {
                winRate: signals.shouldBuy ? 1 : 0,  // If we have a buy signal, consider it a potential win
                averageProfit: 0
            }
        };
        return response;
    }

    private async backtestMomentumStrategy2(
        strategy: TradingStrategy,
        tokenTradeData: TokenTradeData,
        prices: number[],
        volumes: number[]
      ): Promise<BacktestResult> {
        elizaLogger.info("Starting backtestMomentumStrategy for " + strategy.name);
        // For this example, we use a fixed initial capital.
        const initialCapital = 1000;
        let capital = initialCapital;
        let position: { entryIndex: number; entryPrice: number } | null = null;
        const trades: SimulatedTrade[] = [];

        // Determine a lookback period – for RSI, use the period parameter (or default 14)
        const lookbackPeriod = strategy.params.rsiPeriod || 14;

        // Loop through the historical data starting at the lookback period.
        for (let i = lookbackPeriod; i < prices.length; i++) {
          let signal: "buy" | "sell" | "hold" = "hold";

          // Compute the indicator(s) on the slice of data [0, i+1].
          switch (strategy.name) {
            case "RSI CLASSIC": {
              // Compute RSI on the data up to the current time.
              const rsiValues = this.calculateRSI(prices.slice(0, i + 1), strategy.params.rsiPeriod);
              const currentRSI = rsiValues[rsiValues.length - 1];
              // Define oversold (< 30) and overbought (> 70) thresholds.
              if (currentRSI <= 30) {
                signal = "buy";
              } else if (currentRSI >= 70) {
                signal = "sell";
              }
              break;
            }
            case "MACD": {
              // Compute MACD on the slice of prices.
              const macdResult = this.calculateMACD(
                prices.slice(0, i + 1),
                strategy.params.macdFast,
                strategy.params.macdSlow,
                strategy.params.macdSignal
              );
              if (macdResult.buySignal) {
                signal = "buy";
              } else if (macdResult.sellSignal) {
                signal = "sell";
              }
              break;
            }
            case "RATE OF CHANGE MOMENTUM": {
              const rocResult = new ROC({
                values: prices.slice(0, i + 1),
                period: strategy.params.rocPeriod || 12,
              }).getResult();
              if (rocResult.length >= 2) {
                if (rocResult[rocResult.length - 1] > 0 && rocResult[rocResult.length - 2] <= 0) {
                  signal = "buy";
                } else if (rocResult[rocResult.length - 1] < 0 && rocResult[rocResult.length - 2] >= 0) {
                  signal = "sell";
                }
              }
              break;
            }
            default:
              signal = "hold";
              break;
          }

          // Simulate trade execution:
          if (!position && signal === "buy") {
            // Open a new position at the current price.
            position = { entryIndex: i, entryPrice: prices[i] };
            elizaLogger.log(`BUY signal at index ${i} (price: ${prices[i]})`);
          } else if (position && signal === "sell") {
            // Close the open position at the current price.
            const exitPrice = prices[i];
            const profit = exitPrice - position.entryPrice; // simple profit per unit
            capital += profit; // update capital (this is a simplified model)
            trades.push({
              entryIndex: position.entryIndex,
              exitIndex: i,
              entryPrice: position.entryPrice,
              exitPrice: exitPrice,
              profit: profit,
            });
            elizaLogger.log(
              `SELL signal at index ${i} (price: ${exitPrice}). Trade profit: ${profit.toFixed(2)}`
            );
            position = null;
          }
          // Otherwise, hold the position.
        }

        // If a position is still open at the end, close it at the last price.
        if (position) {
          const exitPrice = prices[prices.length - 1];
          const profit = exitPrice - position.entryPrice;
          capital += profit;
          trades.push({
            entryIndex: position.entryIndex,
            exitIndex: prices.length - 1,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            profit: profit,
          });
          elizaLogger.log(
            `Closing open position at end of data (price: ${exitPrice}). Trade profit: ${profit.toFixed(2)}`
          );
          position = null;
        }

        // Calculate performance metrics.
        const totalTrades = trades.length;
        const winningTrades = trades.filter((t) => t.profit > 0).length;
        const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
        const averageProfit =
          totalTrades > 0 ? trades.reduce((sum, t) => sum + t.profit, 0) / totalTrades : 0;
        const cumulativeProfit = capital - initialCapital;

        elizaLogger.log(`Backtest completed for ${strategy.name}`);
        elizaLogger.log(`Total trades: ${totalTrades}, Win rate: ${(winRate * 100).toFixed(2)}%, ` +
                          `Average profit: ${averageProfit.toFixed(2)}, Cumulative profit: ${cumulativeProfit.toFixed(2)}`);

        // Build the backtest result.
        const response: BacktestResult = {
          strategyName: strategy.name,
          totalProfit: cumulativeProfit,
          trades: trades.map((trade) => ({
            type: "buy", // In a more advanced implementation you might record both entries and exits
            price: trade.entryPrice,
            timestamp: "", // You could incorporate timestamp data if available from tokenTradeData
            profit: trade.profit,
          })),
          metrics: {
            winRate: winRate,
            averageProfit: averageProfit,
          },
          // The "signals" field is less relevant in a full backtest.
          signals: {
            shouldBuy: totalTrades > 0 ? 1 : 0,
            shouldSell: 0,
          },
        };

        return response;
      }
}


async function validateTradingExecutionConfig(runtime: IAgentRuntime): Promise<TradingExecutionConfig> {
    const config = {
        BACKEND_URL: runtime.getSetting("BACKEND_URL"),
        SOLANA_RPC_URL: runtime.getSetting("SOLANA_RPC_URL"),
        BASE_MINT: runtime.getSetting("BASE_MINT") || "So11111111111111111111111111111111111111112",
        AUTO_TRADE_ENABLED: runtime.getSetting("AUTO_TRADE_ENABLED") === "true",
        AIRTABLE_API_KEY: runtime.getSetting("AIRTABLE_API_KEY"),
        AIRTABLE_BASE_ID: runtime.getSetting("AIRTABLE_BASE_ID"),
        AIRTABLE_TABLE_NAME: runtime.getSetting("AIRTABLE_TABLE_NAME")
    };

    if (!config.BACKEND_URL) throw new Error("BACKEND_URL is required");
    if (!config.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is required");
    if (!config.AIRTABLE_API_KEY) throw new Error("AIRTABLE_API_KEY is required");
    if (!config.AIRTABLE_BASE_ID) throw new Error("AIRTABLE_BASE_ID is required");
    if (!config.AIRTABLE_TABLE_NAME) throw new Error("AIRTABLE_TABLE_NAME is required");

    elizaLogger.log("TradingExecutionConfig validated successfully...");
    return config;
}

export const TradingExecutionClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        elizaLogger.log("TradingExecutionClientInterface started");
        const tradingExecutionConfig: TradingExecutionConfig = await validateTradingExecutionConfig(runtime);
        const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);
        elizaLogger.log("trustScoreDb set..." + trustScoreDb);
        const walletProvider = new WalletProvider(
            new Connection(tradingExecutionConfig.SOLANA_RPC_URL),
            new PublicKey(tradingExecutionConfig.BASE_MINT)
        );
        elizaLogger.log("walletProvider set..." + walletProvider);
        const manager = new TradingExecutionManager(
            runtime,
            trustScoreDb,
            walletProvider,
            tradingExecutionConfig.BACKEND_URL
        );
        elizaLogger.log("TradingExecutionManager set..." + TradingExecutionManager);

        // Start periodic monitoring
        const monitoringInterval = setInterval(async () => {
            try {
                elizaLogger.log("monitoringInterval starting");

                // Monitor active positions for sell opportunities
                await manager.monitorPrices();

                // Start trading
                await manager.startTradePlan();
            } catch (error) {
                elizaLogger.error("Error in trading monitoring:", error);
            }
        }, 30000); // 30 seconds

        // Store just the interval ID
        runtime.cacheManager.set('tradingMonitorIntervalId', monitoringInterval[Symbol.toPrimitive]());

        return manager;
    },
    async stop(runtime: IAgentRuntime) {
        const interval = await runtime.cacheManager.get('tradingMonitorIntervalId') as NodeJS.Timeout;
        if (interval) {
            clearInterval(interval);
            await runtime.cacheManager.delete('tradingMonitorIntervalId');
        }
        elizaLogger.log("TradingService stopped");
    }
}

export default TradingExecutionClientInterface;
