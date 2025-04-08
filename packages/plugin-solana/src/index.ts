export * from "./providers/token.ts";
export * from "./providers/wallet.ts";
export * from "./providers/trustScoreProvider.ts";
export * from "./evaluators/trust.ts";
import { IAgentRuntime, Service, ServiceType, type Plugin, Client, elizaLogger } from "@elizaos/core";
import transferToken from "./actions/transfer.ts";
import transferSol from "./actions/transfer_sol.ts";
import { WalletProvider } from "./providers/wallet.ts";
import { getTokenBalance, getTokenBalances } from "./providers/tokenUtils.ts";
import { walletProvider } from "./providers/wallet.ts";
import { trustScoreProvider } from "./providers/trustScoreProvider.ts";
import { trustEvaluator } from "./evaluators/trust.ts";
import { executeSwap } from "./actions/swap.ts";
//import { TokenProvider } from "./actions/token_provider.ts";
import { TokenProvider } from "./providers/token";
import take_order from "./actions/takeOrder";
import pumpfun from "./actions/pumpfun.ts";
import fomo from "./actions/fomo.ts";
import { executeSwapForDAO } from "./actions/swapDao";
import { validateSolanaConfig } from "./environment";
import {
    TrustScoreDatabase,
    TokenPerformance
} from "@elizaos/plugin-trustdb";
import { Connection, PublicKey } from "@solana/web3.js";
import { ProcessedTokenData } from "./types/token.ts";
import Airtable from "airtable";
import {
    RSI, MACD, EMA, SMA, WMA, WEMA, ROC,
    BollingerBands, ADX, ATR, CCI, ForceIndex,
    StochasticRSI, PSAR, OBV, TRIX, KST, Stochastic,
    WilliamsR, AwesomeOscillator, IchimokuCloud,
    VWAP, MFI
} from 'technicalindicators';
import { TradingExecutionClientInterface } from "./providers/tradingService";

// Create a service for auto trading
export class AutoTradingService extends Service {
    private runtime: IAgentRuntime | null = null;
    private isRunning: boolean = false;

    static get serviceType(): ServiceType {
        return "autoTrading" as ServiceType;
    }

    async initialize(runtime: IAgentRuntime): Promise<void> {
        this.runtime = runtime;
        await this.startAutoTradingLoop();
    }

    private async startAutoTradingLoop(): Promise<void> {
        if (!this.runtime || this.isRunning) return;

        this.isRunning = true;

        const processLoop = async () => {
            while (this.isRunning) {
                const config = await validateSolanaConfig(this.runtime!);
                if (config.ENABLE_AUTO_TRADING) {
                    try {
                        await Promise.all([
                            executeSwap,
                            take_order,
                            pumpfun,
                            fomo,
                            executeSwapForDAO
                        ]);
                    } catch (error) {
                        console.error("Error in auto trading loop:", error);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
            }
        };

        processLoop().catch(error => {
            console.error("Fatal error in auto trading loop:", error);
            this.isRunning = false;
        });
    }

    // Add method to stop the service if needed
    async stop(): Promise<void> {
        this.isRunning = false;
    }
}

// Check if auto trading is enabled
const isAutoTradingEnabled = process.env.AUTO_TRADING_ENABLED === "true";

export { TokenProvider, WalletProvider, getTokenBalance, getTokenBalances };
export const solanaPlugin: Plugin = {
    name: "solana",
    description: "Solana Plugin for Eliza",
    actions: [
        transferToken,
        transferSol,
        executeSwap,
        pumpfun,
        fomo,
        executeSwapForDAO,
        take_order
    ].filter(action => {
        // Only include trading actions if auto trading is enabled
        if (action.name.includes("_TOKEN") || action.name === "TAKE_ORDER" || action.name === "TRANSFER_SOL") {
            return isAutoTradingEnabled;
        }
        return true;
    }),
    evaluators: [trustEvaluator],
    providers: [walletProvider, trustScoreProvider],
    services: [AutoTradingService.getInstance<AutoTradingService>()],
    clients: [TradingExecutionClientInterface]
};

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
    amount: number;
    trustScore: number;
    riskLevel: 'low' | 'medium' | 'high';
    reasoning: string[];
}
interface Config {
    AIRTABLE_API_KEY: string;
    AIRTABLE_BASE_ID: string;
    AIRTABLE_TABLE_NAME: string;
}

interface BacktestResult {
    strategyName: string;
    totalProfit: number;
    trades: Array<{
        type: 'buy' | 'sell';
        price: number;
        timestamp: string;
        profit?: number;
    }>;
    metrics: {
        winRate: number;
        averageProfit: number;
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
    };
}

interface TradingExecutionConfig {
    BACKEND_URL: string;
    SOLANA_RPC_URL: string;
    BASE_MINT: string;
    AUTO_TRADE_ENABLED: boolean;
}

class TradingExecutionManager {
    private config: Config;
    private airtableBase: Airtable.Base;
    private lastCheck: Date = new Date();
    private monitoredTokens: Set<string> = new Set();
    private runningProcesses: Set<string> = new Set();
    private strategies: TradingStrategy[] = [
        {
            name: 'RSI + MACD',
            type: StrategyType.MOMENTUM,
            params: {
                rsiPeriod: 14,
                rsiOverbought: 70,
                rsiOversold: 30,
                macdFast: 12,
                macdSlow: 26,
                macdSignal: 9
            }
        },
        {
            name: 'EMA Crossover',
            type: StrategyType.TREND,
            params: {
                shortEMA: 9,
                longEMA: 21
            }
        },
        // Add more strategies as needed
    ];

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

        this.airtableBase = new Airtable({ apiKey: this.config.AIRTABLE_API_KEY }).base(this.config.AIRTABLE_BASE_ID);
    }

    async start() {
        elizaLogger.log("Starting TradingExecutionManager...");
        await this.initializeTrustEvaluation();
        await this.start();
    }
    async executeTradeDecision(decision: TradeDecision) {
        const { tokenPerformance, amount, recommender_id, type } = decision;
        const tokenAddress = tokenPerformance.tokenAddress;

        try {
            elizaLogger.log(
                `Executing ${type} for token ${tokenPerformance.symbol}: ${amount}`
            );

            const tokenProvider = new TokenProvider(
                tokenAddress,
                this.walletProvider,
                this.runtime.cacheManager
            );

            if (type === 'buy') {
                return await this.executeBuyDecision(tokenPerformance, amount, recommender_id, tokenProvider);
            } else {
                return await this.executeSellDecision({
                    tokenPerformance,
                    amountToSell: amount,
                    sell_recommender_id: recommender_id
                });
            }
        } catch (error) {
            elizaLogger.error(
                `Error executing ${type} for token ${tokenAddress}:`,
                error
            );
            throw error;
        }
    }

    private async executeBuyDecision(
        tokenPerformance: TokenPerformance,
        amountToBuy: number,
        buy_recommender_id: string | null,
        tokenProvider: TokenProvider
    ) {
        const tokenAddress = tokenPerformance.tokenAddress;

        try {
            const buyDetails: BuyDetails = {
                buy_amount: amountToBuy,
                buy_recommender_id,
            };

            const buyTimeStamp = new Date().toISOString();

            // Get processed token data for market info
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

            return buyDetailsData;
        } catch (error) {
            elizaLogger.error(`Error executing buy for token ${tokenAddress}:`, error);
            throw error;
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

    async executeSellDecision(decision: SellDecision) {
        const { tokenPerformance, amountToSell, sell_recommender_id } = decision;
        const tokenAddress = tokenPerformance.tokenAddress;

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

            return sellDetailsData;
        } catch (error) {
            elizaLogger.error(
                `Error executing sell for token ${tokenAddress}:`,
                error
            );
            throw error;
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

    private async initializeTrustEvaluation() {
        // Initialize trust evaluation components
        elizaLogger.log("Initializing trust evaluation system...");
    }

    async evaluateTradingOpportunity(
        tokenAddress: string
    ): Promise<number> {
        const tokenProvider = new TokenProvider(
            tokenAddress,
            this.walletProvider,
            this.runtime.cacheManager
        );

        const strategyEvaluator = new TradingStrategyEvaluator(
            tokenProvider,
            this.runtime
        );

        const bestStrategy = await strategyEvaluator.evaluateStrategies(tokenAddress);

        // Use the backtest results to determine trust score
        const trustScore = this.calculateTrustFromBacktest(bestStrategy);

        return trustScore;
    }

    private calculateTrustFromBacktest(backtest: BacktestResult): number {
        // Implement logic to convert backtest results to trust score
        const winRateWeight = 0.4;
        const profitWeight = 0.6;

        const winRateScore = backtest.metrics.winRate * 100;
        const profitScore = Math.min(backtest.totalProfit, 100);

        return (winRateScore * winRateWeight) + (profitScore * profitWeight);
    }

    private calculateOverallTrust(
    ): number {
        // Implement trust calculation logic
        // This should combine token and recommender trust factors
        // into a single trust score
        return 0; // Placeholder
    }

    async getTradePlan(): Promise<TradePlan[]> {
        const tradePlans: TradePlan[] = [];

        try {
            const records = await this.airtableBase(this.config.AIRTABLE_TABLE_NAME)
            .select({
                view: "New Prospects",
                maxRecords: 1000,
                fields: ["Mint", "Name", "Symbol", "Uri"]
            })
            .all();

            // Update last check time
            this.lastCheck = new Date();

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
                const tokenPerformance = await this.trustScoreDb.getTokenPerformance(tokenAddress);
                if (!tokenPerformance) continue;

                const trustEvaluation = await this.evaluateTradingOpportunity(
                    tokenAddress
                );

                //const marketConditions = await this.evaluateMarketConditions(tokenAddress);
                const tradePlan = await this.generateTradePlan(
                    tokenPerformance,
                    trustEvaluation
                );

                tradePlans.push(tradePlan);

                // If conditions are perfect, execute buy
                if (this.shouldExecuteBuy(tradePlan)) {
                    const tokenProvider = new TokenProvider(
                        tokenAddress,
                        this.walletProvider,
                        this.runtime.cacheManager
                    );
                    await this.executeBuyDecision(
                        tokenPerformance,
                        tradePlan.amount,
                        null,
                        tokenProvider
                    );
                }
            }
        } catch (error) {
            elizaLogger.error("Error fetching from Airtable:", error);
        }

        return tradePlans;
    }

    private shouldExecuteBuy(tradePlan: TradePlan): boolean {
        // Implement buy decision logic
        // Consider factors like trust score, market conditions, risk level
        return false; // Default to false for safety
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
        tokenPerformance: TokenPerformance,
        trustEvaluation: any
    ): Promise<TradePlan> {
        // Implement trade plan generation logic
        // This should consider trust evaluation, market conditions,
        // and risk parameters
        return {
            tokenAddress: tokenPerformance.tokenAddress,
            action: 'hold', // buy, sell, or hold
            amount: 0,
            trustScore: trustEvaluation.overallTrust,
            riskLevel: 'medium', // low, medium, high
            reasoning: []
        };
    }
}

class TradingStrategyEvaluator {
    private strategies = [
        {
            name: 'RSI Classic',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new RSI({ values: prices, period: 14 }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < 30,
                sellSignal: values[values.length - 1] > 70
            })
        },
        {
            name: 'Rate of Change Momentum',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new ROC({ values: prices, period: 12 }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 0,
                sellSignal: values[values.length - 1] < 0
            })
        },
        {
            name: 'Trend Strength ADX',
            type: StrategyType.TBD,
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
            name: 'Volatility ATR',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new ATR({
                high: prices,
                low: prices,
                close: prices,
                period: 14
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < values[values.length - 2],
                sellSignal: values[values.length - 1] > values[values.length - 2] * 1.5
            })
        },
        {
            name: 'CCI Divergence',
            type: StrategyType.TBD,
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
            name: 'Force Index Trend',
            type: StrategyType.TBD,
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
            name: 'StochasticRSI Crossover',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new StochasticRSI({
                values: prices,
                rsiPeriod: 14,
                stochasticPeriod: 14,
                kPeriod: 3,
                dPeriod: 3
            }).getResult(),
            evaluate: (values: any[]) => ({
                buySignal: values[values.length - 1].k < 20 && values[values.length - 1].k > values[values.length - 1].d,
                sellSignal: values[values.length - 1].k > 80 && values[values.length - 1].k < values[values.length - 1].d
            })
        },
        {
            name: 'On Balance Volume Flow',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[], volume: number[]) => new OBV({
                close: prices,
                volume: volume
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > values[values.length - 2],
                sellSignal: values[values.length - 1] < values[values.length - 2]
            })
        },
        {
            name: 'TRIX Triple Smoothed',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new TRIX({
                values: prices,
                period: 18
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] > 0,
                sellSignal: values[values.length - 1] < 0
            })
        },
        {
            name: 'KST Oscillator',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new KST({
                values: prices,
                ROCPer1: 10,
                ROCPer2: 15,
                ROCPer3: 20,
                ROCPer4: 30,
                SMAROCPer1: 10,
                SMAROCPer2: 10,
                SMAROCPer3: 10,
                SMAROCPer4: 15,
                signalPeriod: 3
            }).getResult(),
            evaluate: (values: any[]) => ({
                buySignal: values[values.length - 1].kst > values[values.length - 1].signal,
                sellSignal: values[values.length - 1].kst < values[values.length - 1].signal
            })
        },
        {
            name: 'Stochastic Oscillator',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new Stochastic({
                high: prices,
                low: prices,
                close: prices,
                period: 14,
                signalPeriod: 3
            }).getResult(),
            evaluate: (values: any[]) => ({
                buySignal: values[values.length - 1].k < 20 && values[values.length - 1].k > values[values.length - 1].d,
                sellSignal: values[values.length - 1].k > 80 && values[values.length - 1].k < values[values.length - 1].d
            })
        },
        {
            name: 'Williams %R',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[]) => new WilliamsR({
                high: prices,
                low: prices,
                close: prices,
                period: 14
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < -80,
                sellSignal: values[values.length - 1] > -20
            })
        },
        {
            name: 'Awesome Oscillator',
            type: StrategyType.TBD,
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
        },
        {
            name: 'MFI Strategy',
            type: StrategyType.TBD,
            params: {},
            indicator: (prices: number[], volume: number[]) => new MFI({
                high: prices,
                low: prices,
                close: prices,
                volume: volume,
                period: 14
            }).getResult(),
            evaluate: (values: number[]) => ({
                buySignal: values[values.length - 1] < 20,
                sellSignal: values[values.length - 1] > 80
            })
        }
    ];

    constructor(
        private tokenProvider: TokenProvider,
        private runtime: IAgentRuntime
    ) {}

    async findBestStrategy(tokenAddress: string): Promise<{
        bestStrategy: string;
        backtest: BacktestResult;
    }> {
        const results = await this.evaluateAllStrategies(tokenAddress);
        const bestResult = results.reduce((best, current) =>
            current.totalProfit > best.totalProfit ? current : best
        );

        return {
            bestStrategy: bestResult.strategyName,
            backtest: bestResult
        };
    }

    async evaluateAllStrategies(tokenAddress: string): Promise<BacktestResult[]> {
        // Get trade data
        const tradeData = await this.tokenProvider.fetchTokenTradeData(tokenAddress);
        const prices = [
            tradeData.history_30m_price,
            tradeData.history_1h_price,
            tradeData.history_2h_price,
            tradeData.history_4h_price,
            tradeData.history_6h_price,
            tradeData.history_8h_price,
            tradeData.history_12h_price,
            tradeData.history_24h_price
        ];
        const volumes = [
            tradeData.volume_30m,
            tradeData.volume_1h,
            tradeData.volume_2h,
            tradeData.volume_4h,
            tradeData.volume_8h,
            tradeData.volume_24h
        ];

        // Get last trade time
        const lastTradeTime = tradeData.last_trade_unix_time;
        const timestamps = prices.map((_, index) => {
            const intervals = [0.5, 1, 2, 4, 6, 8, 12, 24]; // hours
            const hoursAgo = intervals[index];
            return lastTradeTime - (hoursAgo * 60 * 60 * 1000); // convert hours to milliseconds
        });

        return Promise.all(this.strategies.map(async strategy => {
            const indicatorValues = strategy.indicator(prices, volumes);
            let inPosition = false;
            let entryPrice = 0;
            let totalProfit = 0;
            const trades = [];

            for (let i = 0; i < prices.length; i++) {
                const signals = strategy.evaluate(indicatorValues.slice(0, i + 1));

                if (!inPosition && signals.buySignal) {
                    inPosition = true;
                    entryPrice = prices[i];
                    trades.push({
                        type: 'buy',
                        price: entryPrice,
                        timestamp: timestamps[i]
                    });
                } else if (inPosition && signals.sellSignal) {
                    const exitPrice = prices[i];
                    const profit = ((exitPrice - entryPrice) / entryPrice) * 100;
                    totalProfit += profit;
                    inPosition = false;
                    trades.push({
                        type: 'sell',
                        price: exitPrice,
                        timestamp: timestamps[i],
                        profit
                    });
                }
            }

            return {
                strategyName: strategy.name,
                totalProfit,
                trades,
                metrics: {
                    winRate: trades.filter(t => t.type === 'sell' && t.profit > 0).length /
                            trades.filter(t => t.type === 'sell').length,
                    averageProfit: totalProfit / trades.filter(t => t.type === 'sell').length
                }
            };
        }));
    }

    async evaluateStrategies(tokenAddress: string): Promise<BacktestResult> {
        const historicalData = await this.tokenProvider.fetchTokenTradeData(tokenAddress);
        let bestStrategy: TradingStrategy | null = null;
        let bestProfit = 0;
        let bestBacktestResult: BacktestResult | null = null;

        for (const strategy of this.strategies) {
            const backtestResult = await this.backtestStrategy(
                strategy as TradingStrategy,
                historicalData
            );

            if (backtestResult.totalProfit > bestProfit) {
                bestProfit = backtestResult.totalProfit;
                bestStrategy = strategy as TradingStrategy;
                bestBacktestResult = backtestResult;
            }
        }

        return bestBacktestResult!;
    }

    private async backtestStrategy(
        strategy: TradingStrategy,
        historicalData: any
    ): Promise<BacktestResult> {
        switch (strategy.type) {
            case StrategyType.MOMENTUM:
                return this.backtestMomentumStrategy(strategy, historicalData);
            case StrategyType.TREND:
                return this.backtestTrendStrategy(strategy, historicalData);
            default:
                throw new Error(`Unknown strategy type: ${strategy.type}`);
        }
    }

    private async backtestTrendStrategy(
        strategy: TradingStrategy,
        historicalData: any[]
    ): Promise<BacktestResult> {
        const prices = historicalData.map(d => d.price);
        const shortEMA = this.calculateEMA(prices, strategy.params.shortEMA || 9);
        const longEMA = this.calculateEMA(prices, strategy.params.longEMA || 21);

        let inPosition = false;
        let entryPrice = 0;
        let totalProfit = 0;
        const trades = [];

        for (let i = 1; i < prices.length; i++) {
            if (!inPosition && shortEMA[i] > longEMA[i] && shortEMA[i-1] <= longEMA[i-1]) {
                // Buy signal - EMA crossover
                inPosition = true;
                entryPrice = prices[i];
                trades.push({
                    type: 'buy',
                    price: entryPrice,
                    timestamp: historicalData[i].timestamp
                });
            } else if (inPosition && shortEMA[i] < longEMA[i] && shortEMA[i-1] >= longEMA[i-1]) {
                // Sell signal - EMA crossover
                const exitPrice = prices[i];
                const profit = (exitPrice - entryPrice) / entryPrice * 100;
                totalProfit += profit;
                inPosition = false;
                trades.push({
                    type: 'sell',
                    price: exitPrice,
                    timestamp: historicalData[i].timestamp,
                    profit
                });
            }
        }

        return {
            strategyName: strategy.name,
            totalProfit,
            trades,
            metrics: {
                winRate: trades.filter(t => t.type === 'sell' && t.profit > 0).length /
                        trades.filter(t => t.type === 'sell').length,
                averageProfit: totalProfit / trades.filter(t => t.type === 'sell').length
            }
        };
    }

    private calculateRSI(prices: number[], period: number): number[] {
        // Implement RSI calculation
        return [];
    }

    private calculateMACD(prices: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): any {
        // Implement MACD calculation
        return {};
    }

    private calculateEMA(prices: number[], period: number): number[] {
        // Implement EMA calculation
        return [];
    }

    private async backtestMomentumStrategy(
        strategy: TradingStrategy,
        historicalData: any[]
    ): Promise<BacktestResult> {
        const prices = historicalData.map(d => d.price);
        const rsi = this.calculateRSI(prices, strategy.params.rsiPeriod);
        const macd = this.calculateMACD(
            prices,
            strategy.params.macdFast,
            strategy.params.macdSlow,
            strategy.params.macdSignal
        );

        let inPosition = false;
        let entryPrice = 0;
        let totalProfit = 0;
        const trades = [];

        for (let i = 1; i < prices.length; i++) {
            if (!inPosition &&
                rsi[i] < strategy.params.rsiOversold &&
                macd.histogram[i] > 0) {
                // Buy signal
                inPosition = true;
                entryPrice = prices[i];
                trades.push({
                    type: 'buy',
                    price: entryPrice,
                    timestamp: historicalData[i].timestamp
                });
            } else if (inPosition &&
                      (rsi[i] > strategy.params.rsiOverbought ||
                       macd.histogram[i] < 0)) {
                // Sell signal
                const exitPrice = prices[i];
                const profit = (exitPrice - entryPrice) / entryPrice * 100;
                totalProfit += profit;
                inPosition = false;
                trades.push({
                    type: 'sell',
                    price: exitPrice,
                    timestamp: historicalData[i].timestamp,
                    profit
                });
            }
        }

        return {
            strategyName: strategy.name,
            totalProfit,
            trades,
            metrics: {
                winRate: trades.filter(t => t.type === 'sell' && t.profit > 0).length /
                        trades.filter(t => t.type === 'sell').length,
                averageProfit: totalProfit / trades.filter(t => t.type === 'sell').length
            }
        };
    }
}

async function validateTradingExecutionConfig(runtime: IAgentRuntime): Promise<TradingExecutionConfig> {
    const config = {
        BACKEND_URL: runtime.getSetting("BACKEND_URL"),
        SOLANA_RPC_URL: runtime.getSetting("SOLANA_RPC_URL"),
        BASE_MINT: runtime.getSetting("BASE_MINT") || "So11111111111111111111111111111111111111112",
        AUTO_TRADE_ENABLED: runtime.getSetting("AUTO_TRADE_ENABLED") === "true"
    };

    if (!config.BACKEND_URL) throw new Error("BACKEND_URL is required");
    if (!config.SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is required");

    return config;
}
export { TradingExecutionClientInterface } from "./providers/tradingService";
