import type { Plugin, IAgentRuntime, Memory, State } from "@elizaos/core";
import { elizaLogger, generateText, ModelClass, settings, generateImage } from "@elizaos/core";
import { TwitterClientInterface } from "@elizaos/client-twitter";
import {createNftWithExistingImage} from "./services/nft";
import { TelegramClientInterface } from "@elizaos/client-telegram";
import { DiscordClientInterface } from "@elizaos/client-discord";
import {
    solanaPlugin,
    trustScoreProvider,
    trustEvaluator,
    getTokenBalance,
} from "@elizaos/plugin-solana";
import { TokenProvider } from "./providers/token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Chain, WalletClient, Signature, Balance } from "@goat-sdk/core";
import * as fs from "fs";
import * as path from "path";
import { TrustScoreProvider } from "./providers/trustScoreProvider";
import { SimulationService } from "./services/simulationService";
import { SAFETY_LIMITS } from "./constants";
import NodeCache from "node-cache";
import { TradePosition, TrustScoreDatabase } from "@elizaos/plugin-trustdb";
import { v4 as uuidv4 } from "uuid";
import { actions } from "./actions";
import {
    FreqTradeAlert,
    TradeAlert,
    TradeBuyAlert,
    tweetSell,
    tweetTrade,
    TwitterConfigSchema,
    TwitterService,
} from "./services/twitter";
import {
    executeTrade,
    getChainWalletBalance,
    getWalletBalance,
    getWalletKeypair
} from "./wallet";
import { ProcessedTokenData } from "./types";
import { analyzeTradeAction } from "./actions/analyzeTrade";
import Airtable from "airtable";
import { sendTelegramMessage, TelegramConfig, TelegramService } from "./services/telegram";
import { ArbitrageManager } from "./services/arbitrage";
import { LongTermManager } from "./services/longterm";
import { updateAirtableStatus } from "./services/airtable";
import { updateFreqtradeAirtableStatus } from "./services/airtable";
import { createAirtableRecord } from "./services/airtable";
import { AIDecisionService } from "./services/ai-decision";
import { ExtendedBalance, ExtendedWalletProvider } from "./types/types";
import { FreqtradeManager } from "./services/freqtrade";
import { imageGenerationPlugin } from "@elizaos/plugin-image-generation";
//import { DiscordConfig, DiscordService } from "./services/discord";
import { sendDiscordMessage as sendDiscordMessageToChannel } from "./services/discord";
import { checkForLatestMinedBlocks } from "./services/bitcoin-blocks";
import { createNftFromImage } from "./services/solanaNft";

let ACTIVE_MONITORING_INTERVAL = 20 * 1000;  // 20 seconds
let walletProvider: ExtendedWalletProvider;
let freqtradeInitialized = false;
let lastInitDate = '';
//let discordService: DiscordService | undefined;
let twitterService: TwitterService | undefined;
let telegramService: TelegramService | undefined;
const shouldTweetTradeForSolanaMemeCoins = true;
const shouldCreateNftForSolanaMemeCoins = false;
const agentkitTradeRecords: Map<string, AgentkitTradeRecord> = new Map();
const tweetRateCache = new NodeCache({
    stdTTL: 86400, // 24 hours in seconds
    checkperiod: 3600, // Check every hour
});

interface ExtendedPlugin extends Plugin {
    name: string;
    description: string;
    evaluators: any[];
    providers: any[];
    actions: any[];
    services: any[];
    autoStart?: boolean;
}

interface TweetRateLimit {
    lastTweet: number;
    count: number; // Track number of tweets in the time window
}

// Add new interfaces near the top with other interfaces
interface TradePerformance {
    token_address: string;
    recommender_id: string;
    buy_price: number;
    sell_price: number;
    buy_timeStamp: string;
    sell_timeStamp: string;
    buy_amount: number;
    sell_amount: number;
    buy_value_usd: number;
    sell_value_usd: number;
    buy_market_cap: number;
    sell_market_cap: number;
    buy_liquidity: number;
    sell_liquidity: number;
    profit_usd: number;
    profit_percent: number;
    market_cap_change: number;
    liquidity_change: number;
    rapidDump: boolean;
    buy_sol: number;
    received_sol: number;
    last_updated: string;
}

// Update the analysisParams interface
interface AnalysisParams extends Record<string, any> {
    walletBalance: number;
    tokenAddress: string;
    price: number;
    volume: number;
    marketCap: number;
    liquidity: number;
    holderDistribution: string;
    trustScore: number;
    dexscreener: any;
    position?: TradePosition;
    tradeHistory?: TradePerformance[];
}

// Update the interface to match the SQL parameter order
interface SellDetailsData {
    // SET clause parameters in order
    sell_price: number;
    sell_timeStamp: string;
    sell_amount: number;
    received_sol: number;
    sell_value_usd: number;
    profit_usd: number;
    profit_percent: number;
    sell_market_cap: number;
    market_cap_change: number;
    sell_liquidity: number;
    liquidity_change: number;
    rapidDump: boolean;
    sell_recommender_id: string | null;
}
interface FreqtradeConfig {
    enabled: boolean;
    logsPath: string;
    resultsPath: string;
    scriptPath: string;
    monitorInterval: number;
    performanceThreshold: number;
    optimizationInterval: number; // How often to re-optimize (ms)
    logPath: string;
}

interface AgentkitTradeRecord {
    tokenAddress: string;
    buyPrice: number;
    buyAmount: number;
    buyTimestamp: string;
    recommenderId: string;
}

interface AgentkitTradeRecord {
    tokenAddress: string;
    buyPrice: number;
    buyAmount: number;
    buyTimestamp: string;
    recommenderId: string;
}

/**
 * Fetch tokens from Airtable
 * @param runtime Runtime for state and other services
 * @returns Array of tokens from Airtable
 */
async function fetchAgentkitTokensFromAirtable(runtime?: IAgentRuntime) {
    try {
        // Assumes AIRTABLE_API_KEY and AIRTABLE_BASE_ID are set in the environment.
        const airtableBase: Airtable.Base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        const records = await airtableBase("AgentKitTokens")
            .select({
                view: "AgentKitReadyList",
                maxRecords: 1000,
                fields: ["TokenID", "Price Open", "Price Close","Percent Increase", "Volume"]
            })
            .all();
        elizaLogger.log(`Fetched ${records.length} AgentKit tokens from Airtable.`);
        return records.map((record: any) => ({
            tokenId: record.fields["TokenID"],
            price: record.fields["Price"],
            volume: record.fields["Volume"]
        }));
    } catch (error) {
        elizaLogger.error("Error fetching AgentKit tokens from Airtable:", error);
        return [];
    }
}

/**
 * Analyze an AgentKit token
 * @param runtime Runtime for state and other services
 * @param tokenRecord Airtable record containing token details
 */
async function analyzeAgentkitToken(
    runtime: IAgentRuntime,
    tokenRecord: any
): Promise<void> {
    try {
        // Extract token details from the record object
        const tokenId = tokenRecord.tokenId;
        if (!tokenId) {
            elizaLogger.error("AgentKit token record missing tokenId");
            return;
        }
        elizaLogger.log("AgentKit token record:", tokenRecord);

        const analysisMemory: Memory = {
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content: {
                text: `Analyze AgentKit token ${tokenId} with details: Price=${tokenRecord.price}, Volume=${tokenRecord.volume}. Provide a JSON response with keys:
                {
                "recommendedAction": "BUY" | "SELL" | "HOLD",
                "confidence": number,
                "trustScore": number
                }`,
                type: "analysis",
            },
        };
        let state: State = await runtime.composeState(analysisMemory);
        state = await runtime.updateRecentMessageState(state);
        elizaLogger.log("AgentKit state:", state);

        const context = `AgentKit Token Analysis:
            TokenID: ${tokenId}
            Price: ${tokenRecord.price}
            Volume: ${tokenRecord.volume}
            Based on the above, output a JSON object with:
            {
            "recommendedAction": "BUY" | "SELL" | "HOLD",
            "confidence": number,
            "trustScore": number
            }`;
        // Invoke the AI model to generate the analysis response.
        elizaLogger.log(`CDP AgentKit token analysis context for ${tokenId}: ${context}`);
        const cdpAnalysisResponse = await generateText({
            runtime,
            context,
            modelClass: ModelClass.LARGE,
        });
        elizaLogger.log(`CDP AgentKit token analysis response for ${tokenId}: ${cdpAnalysisResponse}`);

        // Attempt to parse the AI response.
        let decision;
        try {
            // Extract just the JSON object from the response
            const jsonMatch = cdpAnalysisResponse.match(/```json\s*({[\s\S]*?})\s*```/);

            if (jsonMatch && jsonMatch[1]) {
                // Parse the extracted JSON
                decision = JSON.parse(jsonMatch[1]);
                elizaLogger.log("CDP AgentKit decision:", decision);
            } else {
                // Fallback to direct parsing if no code block found
                decision = JSON.parse(cdpAnalysisResponse);
            }
        } catch (parseError) {
            elizaLogger.error(`Failed to parse analysis response for ${tokenId}: ${cdpAnalysisResponse}`, parseError);
            // Log more detailed error information
            elizaLogger.error("Parse error details:", {
                message: parseError.message,
                stack: parseError.stack
            });
            return;
        }

        /*
        // Decision making based solely on the AI analysis:
        if (decision.recommendedAction === "BUY") {
            // If no open position exists, execute a BUY.
            if (!agentkitTradeRecords.has(tokenId)) {
                const tokenPrice = Number(tokenRecord.price);
                const tradeAmount = SAFETY_LIMITS.MINIMUM_TRADE;
                const buySuccess = await agentkitBuy({ runtime, tokenAddress: tokenId, tradeAmount, tokenPrice });
                if (buySuccess) {
                    elizaLogger.log(`AgentKit BUY executed for ${tokenId} at $${tokenPrice}`);
                }
            } else {
                elizaLogger.log(`AgentKit token ${tokenId} already has an open position, skipping BUY.`);
            }
        } else if (decision.recommendedAction === "SELL") {
            // If an open position exists, attempt a SELL.
            if (agentkitTradeRecords.has(tokenId)) {
                const tokenPrice = Number(tokenRecord.price);
                const sellSuccess = await agentkitSell({ runtime, tokenAddress: tokenId, currentPrice: tokenPrice });
                if (sellSuccess) {
                    elizaLogger.log(`AgentKit SELL executed for ${tokenId} at $${tokenPrice}`);
                }
            } else {
                elizaLogger.log(`No open AgentKit position for ${tokenId} to sell.`);
            }
        } else {
            elizaLogger.log(`AgentKit token ${tokenId} analysis recommends HOLD.`);
        }*/
    } catch (error) {
        elizaLogger.error(`Error analyzing AgentKit token`, error);
    }
}

/**
 * Validate a Solana address
 * @param address The address to validate
 * @returns True if the address is valid, false otherwise
 */
function validateSolanaAddress(address: string | undefined): boolean {
    if (!address) return false;
    try {
        // Handle Solana addresses
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
            elizaLogger.warn(`Solana address failed format check: ${address}`);
            return false;
        }

        // Verify it's a valid Solana public key
        const pubKey = new PublicKey(address);
        const isValid = Boolean(pubKey.toBase58());
        elizaLogger.log(
            `Solana address validation result for ${address}: ${isValid}`
        );
        return isValid;
    } catch (error) {
        elizaLogger.error(`Address validation error for ${address}:`, error);
        return false;
    }
}

/*
 * Can tweet
 * @param tweetType The type of tweet
 * @returns True if the tweet can be tweeted, false otherwise
 */
function canTweet(tweetType: "trade" | "market_search"): boolean {
    const now = Date.now();
    const hourKey = `tweets_${tweetType}_${Math.floor(now / 3600000)}`; // Key by hour and type
    const rateLimit: TweetRateLimit = tweetRateCache.get(hourKey) || {
        lastTweet: now,
        count: 0,
    };

    // Different limits for different tweet types
    const MAX_TWEETS_PER_HOUR = {
        trade: 13,
        market_search: 13, // Lower limit for market search tweets
    };

    if (rateLimit.count >= MAX_TWEETS_PER_HOUR[tweetType]) {
        elizaLogger.warn(
            `Tweet rate limit reached for ${tweetType}: ${rateLimit.count} tweets this hour`
        );
        return false;
    }

    // Update rate limit
    tweetRateCache.set(hourKey, {
        lastTweet: now,
        count: rateLimit.count + 1,
    });

    return true;
}

/**
 * Update the sell details
 * @param runtime Runtime for state and other services
 * @param tokenAddress Token address
 * @param recommenderId Recommender ID
 * @param tradeAmount Trade amount
 * @param latestTrade Latest trade
 */
async function updateSellDetails(
    runtime: IAgentRuntime,
    tokenAddress: string,
    recommenderId: string,
    tradeAmount: number,
    latestTrade: any,
    tokenData: any
) {
    elizaLogger.log(`Updating sell details for ${tokenAddress}`);
    const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);

    //const trade = await trustScoreDb.getLatestTradePerformance(
    //    tokenAddress,
    //    recommenderId,
    //    false
    //);
    const trade = await withDatabaseRetry<TradePerformance>(() =>
        trustScoreDb.getLatestTradePerformance(tokenAddress, runtime.agentId, false)
    );

    if (!trade) {
        elizaLogger.error(
            `No trade found for token ${tokenAddress} and recommender ${recommenderId}`
        );
        throw new Error("No trade found to update");
    }

    elizaLogger.info("tokenData", tokenData);
    const currentPrice = tokenData.dexScreenerData.pairs[0]?.priceUsd || 0;
    const marketCap = tokenData.dexScreenerData.pairs[0]?.marketCap || 0;
    const liquidity = tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0;

    const sellValueUsd = tradeAmount * Number(currentPrice);
    const profitUsd = sellValueUsd - trade.buy_value_usd;
    const profitPercent = (profitUsd / trade.buy_value_usd) * 100;

    elizaLogger.log(`Trade: ${trade}`);
    elizaLogger.log(`Current price: ${currentPrice}`);
    elizaLogger.log(`Market cap: ${marketCap}`);
    elizaLogger.log(`Liquidity: ${liquidity}`);
    elizaLogger.log(`Sell value usd: ${sellValueUsd}`);
    elizaLogger.log(`Profit usd: ${profitUsd}`);
    elizaLogger.log(`Profit percent: ${profitPercent}`);

    // Create sellDetailsData object matching SQL parameter order
    const sellDetails: SellDetailsData = {
        sell_price: Number(currentPrice),
        sell_timeStamp: new Date().toISOString(),
        sell_amount: tradeAmount,
        received_sol: tradeAmount,
        sell_value_usd: sellValueUsd,
        profit_usd: profitUsd,
        profit_percent: profitPercent,
        sell_market_cap: marketCap,
        market_cap_change: marketCap - trade.buy_market_cap,
        sell_liquidity: liquidity,
        liquidity_change: liquidity - trade.buy_liquidity,
        rapidDump: false,
        sell_recommender_id: recommenderId || null,
    };

    elizaLogger.log("Attempting to update trade performance with data:", {
        sellDetails,
        whereClause: {
            tokenAddress,
            recommenderId,
            buyTimeStamp: trade.buy_timeStamp,
        },
        isSimulation: false,
    });

    try {
        try {
            // Pass sellDetails first (SET clause), then WHERE clause parameters
            elizaLogger.log(
                "Verifying parameters for updateTradePerformanceOnSell:",
                {
                    sellDetails,
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                    isSimulation: false,
                }
            );

            const success = await trustScoreDb.updateTradePerformanceOnSell(
                tokenAddress, // 1. WHERE token_address = ?
                recommenderId, // 2. WHERE recommender_id = ?
                trade.buy_timeStamp, // 3. WHERE buy_timeStamp = ?
                sellDetails, // 4. SET clause parameters
                false // 5. isSimulation flag
            );

            if (!success) {
                elizaLogger.warn("Trade update returned false", {
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                });
            }

            elizaLogger.log("Trade performance update completed", {
                success,
                tokenAddress,
                recommenderId,
                profitPercent: profitPercent.toFixed(2) + "%",
                profitUsd: profitUsd.toFixed(4) + " USD",
            });
        } catch (dbError) {
            elizaLogger.error("Database error during trade update:", {
                error: dbError,
                query: {
                    sellDetails,
                    whereClause: {
                        tokenAddress,
                        recommenderId,
                        buyTimeStamp: trade.buy_timeStamp,
                    },
                },
            });
            throw dbError;
        }
    } catch (error) {
        elizaLogger.error("Failed to update trade performance:", {
            error,
            parameters: {
                sellDetails,
                whereClause: {
                    tokenAddress,
                    recommenderId,
                    buyTimeStamp: trade.buy_timeStamp,
                },
                originalTrade: trade,
            },
            errorDetails:
                error instanceof Error
                    ? {
                          message: error.message,
                          stack: error.stack,
                          name: error.name,
                      }
                    : error,
        });
        throw error;
    }

    return {
        sellDetails,
        currentPrice,
        profitDetails: {
            profitUsd,
            profitPercent,
            sellValueUsd,
        },
    };
}

/*
 * Get the chain balance
 * @param connection Solana connection
 * @param walletAddress Wallet address
 * @param tokenAddress Token address
 * @returns The chain balance
 */
async function getChainBalance(
    connection: Connection,
    walletAddress: PublicKey,
    tokenAddress: string
): Promise<number> {
    // Use existing Solana balance fetching logic
    return await getTokenBalance(
        connection,
        walletAddress,
        new PublicKey(tokenAddress)
    );
}

/**
 * Get a random delay
 * @param attempt The attempt number
 * @returns A random number between 500ms (0.5s) and 10000ms (10s)
 */
function getRandomDelay(attempt: number): number {
    const BASE_DELAY = 2000;  // 2 seconds
    const MAX_DELAY = 10000;  // 10 seconds
    const JITTER_FACTOR = 0.5;  // 50% random jitter
    // Exponential backoff: 2s, 4s, 8s, etc up to MAX_DELAY
    const baseDelay = Math.min(BASE_DELAY * Math.pow(2, attempt), MAX_DELAY);

    // Add random jitter: ±50% of base delay
    const jitter = baseDelay * JITTER_FACTOR * (Math.random() - 0.5);

    return Math.floor(baseDelay + jitter);
}

/**
 * Get a random delay
 * @returns A random number between 500ms (0.5s) and 10000ms (10s)
 */
function getRandomDelay2(): number {
    const BASE_DELAY = 2000;  // 2 seconds
    const MAX_DELAY = 10000;  // 10 seconds
    const JITTER_FACTOR = 0.5;  // 50% random jitter
    // Returns a random number between 500ms (0.5s) and 10000ms (10s)
    const baseDelay = Math.min(BASE_DELAY * Math.pow(2, 1), MAX_DELAY);
    const jitter = baseDelay * JITTER_FACTOR * (Math.random() - 0.5);
    return Math.floor(Math.random() * 9500) + jitter; // 500ms to 10000ms
}

/**
 * Initialize FreqTrade trading strategy service once per day
 * @param runtime Runtime for state and other services
 * @param twitterService Twitter service for notifications
 * @param getSetting Function to get settings from environment
 */
async function runFreqTrade(
    runtime: IAgentRuntime | undefined,
    twitterService: TwitterService | undefined,
    getSetting: (key: string) => string | undefined
) {
    // Check if already initialized today
    const currentDate = new Date().toDateString();
    const initMarkerPath = path.resolve(process.cwd(), 'logs/freqtrade_init_marker.txt');
    elizaLogger.log(`runFreqTrade initMarkerPath: ${initMarkerPath}`);
    try {
        elizaLogger.log("Running FreqTrade initialization");
        // Check if marker file exists and contains today's date
        if (fs.existsSync(initMarkerPath)) {
            const fileContent = fs.readFileSync(initMarkerPath, 'utf8').trim();
            if (fileContent === currentDate) {
                elizaLogger.log("FreqTrade already initialized today (verified by marker file), skipping initialization");
                return;
            }
        }
        elizaLogger.log("FreqTrade not initialized today, continuing with initialization");

        // Continue with initialization since it hasn't been done today
        const freqtradeConfig: FreqtradeConfig = {
            enabled: getSetting("FREQTRADE_ENABLED") === "true",
            logsPath: getSetting("FREQTRADE_LOGS_PATH") || path.resolve(process.cwd(), "user_data/logs"),
            scriptPath: getSetting("FREQTRADE_SCRIPT_PATH") || path.resolve(process.cwd(), "scripts/freqtrade"),
            resultsPath: getSetting("FREQTRADE_RESULTS_PATH") || path.resolve(process.cwd(), "user_data/results"),
            monitorInterval: parseInt(getSetting("FREQTRADE_MONITOR_INTERVAL") || "300000"), // 5 minutes
            performanceThreshold: parseFloat(getSetting("FREQTRADE_PERFORMANCE_THRESHOLD") || "-5"), // -5%
            optimizationInterval: parseInt(getSetting("FREQTRADE_OPTIMIZATION_INTERVAL") || "86400000"), // 24 hours
            logPath: getSetting("FREQTRADE_LOG_PATH") || path.resolve(process.cwd(), "logs/freqtrade.log")
        };
        elizaLogger.log("FreqTrade config:", freqtradeConfig);
        if (freqtradeConfig.enabled && runtime) {
            elizaLogger.log("Initializing FreqTrade integration...");
            let freqtradeManager: FreqtradeManager | null = null;
            try {
                freqtradeManager = new FreqtradeManager(freqtradeConfig, runtime);
                await freqtradeManager.start(twitterService);

                // Write to marker file with today's date
                // Ensure logs directory exists
                const logsDir = path.resolve(process.cwd(), 'logs');
                if (!fs.existsSync(logsDir)) {
                    fs.mkdirSync(logsDir, { recursive: true });
                }

                // Then write to the file
                fs.writeFileSync(initMarkerPath, currentDate);
                elizaLogger.log(`FreqTrade initialized and marker file created for date: ${currentDate}`);

                if (twitterService) {
                    try {
                        // Get today's date in YYYYMMDD format
                        const today = new Date();
                        const dateString = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

                        // Path to the strategy file
                        const strategyFilePath = `/home/ai/freqtrade/user_data/results/deploy_strategy_kraken_${dateString}.txt`;

                        elizaLogger.log("runFreqTrade strategy file path:", strategyFilePath);

                        // Default values
                        let strategy = "ScalpingStrategy";
                        let timeframe = "30m";
                        let pair = "BTC/USD";
                        let profit = 0;
                        let tradeCount = 0;
                        let winRate = 0;

                        // Try to read from file if it exists
                        if (fs.existsSync(strategyFilePath)) {
                            const fileContent = fs.readFileSync(strategyFilePath, 'utf8');
                            elizaLogger.log("runFreqTrade strategy file content:", fileContent);
                            // Parse the actual format of the file
                            const strategyMatch = fileContent.match(/Best Strategy:\s*([\w\d]+)/i);
                            if (strategyMatch) strategy = strategyMatch[1];
                            elizaLogger.log("runFreqTrade strategy:", strategy);
                            const timeframeMatch = fileContent.match(/Timeframe:\s*([\w-]+)/i);
                            timeframe = timeframeMatch ? timeframeMatch[1].trim() : "5m";
                            elizaLogger.log("runFreqTrade timeframe:", timeframe);
                            // Check if timeframe is valid (should be like 5m, 15m, 1h, etc.)
                            if (!timeframe.match(/^\d+[mhdw]$/i)) {
                                timeframe = "5m"; // Use default if invalid format
                            }

                            // Extract pair from best pair if available
                            const bestPairMatch = fileContent.match(/Best Pair:\s*([^\n]+)/i);
                            if (bestPairMatch && bestPairMatch[1].trim() !== "Not found") {
                                pair = bestPairMatch[1].trim();
                            } else {
                                // Try to find any trading pair format in file (XXX/YYY)
                                const pairPattern = /([A-Z0-9]+)\/([A-Z0-9]+)/i;
                                const anyPairMatch = fileContent.match(pairPattern);
                                pair = anyPairMatch ? anyPairMatch[0] : "BTC/USDT";
                            }
                            elizaLogger.log("runFreqTrade pair:", pair);

                            // Try to extract trade count - attempt to find any number after "Trade Count:"
                            const tradeCountMatch = fileContent.match(/Trade Count:\s*(\d+)/i);
                            tradeCount = tradeCountMatch ? parseInt(tradeCountMatch[1]) : 0;
                            if (isNaN(tradeCount)) tradeCount = 0;

                            // Try to extract win rate - attempt to find any percentage after "Win Rate:"
                            const winRateMatch = fileContent.match(/Win Rate:\s*([\d.]+)%/i);
                            winRate = winRateMatch ? parseFloat(winRateMatch[1]) : 0;
                            if (isNaN(winRate)) winRate = 0;

                            // Extract profit
                            const profitMatch = fileContent.match(/Total Profit:\s*([-\d.]+)%/i);
                            if (profitMatch) profit = parseFloat(profitMatch[1]);
                        } else {
                            elizaLogger.warn(`Strategy file not found: ${strategyFilePath}, using default values`);
                        }

                        // Create FreqTrade alert with the extracted data
                        await twitterService.postFreqTradeAlert({
                            strategy,
                            timeframe,
                            pair,
                            profit,
                            tradeCount,
                            winRate,
                            timestamp: Date.now()
                        });

                        elizaLogger.log("Posted FreqTrade initialization tweet");
                    } catch (tweetError) {
                        elizaLogger.error("Failed to post FreqTrade initialization tweet:", tweetError);
                    }
                }
            } catch (error) {
                elizaLogger.error("Failed to initialize FreqTrade:", error);
            }
        }
        else{
            elizaLogger.log("FreqTrade is not ENABLED, skipping initialization");
        }
    } catch (error) {
        elizaLogger.error("Error checking FreqTrade initialization marker:", error);
    }
}

/**
 * Generate a trade swap image
 * @param runtime The runtime environment
 * @param tradeData The trade data
 * @returns The path to the generated image, or null if an error occurs
 */
const generateTradeSwapImage = async (
    runtime: IAgentRuntime,
    tradeData: TradeAlert,
): Promise<string | null> => {
    try {
        elizaLogger.logColorful(`Generating ${tradeData.action} trade image for ${tradeData.token}...`);

        if (!runtime) {
            elizaLogger.error("Cannot generate image: runtime is undefined");
            return null;
        }

        // Arrays of dynamic options for prompt variety
        const backgroundStyles = [
            "dark background with neon blue and purple accents",
            "deep black background with vibrant cyan and magenta highlights",
            "rich navy background with electric teal and crimson highlights",
            "midnight blue background with gold and emerald accents",
            "dark charcoal background with violet and orange neon highlights",
            "deep purple background with turquoise and amber accents",
            "obsidian black background with electric green and fuchsia highlights",
            "slate gray background with cobalt and ruby accents",
            "dark teal background with yellow and pink highlights",
            "deep burgundy background with silver and blue accents"
        ];

        const chartStyles = [
            "sharp, angular candlestick patterns",
            "smooth, flowing line charts",
            "bold, geometric bar graphs",
            "futuristic holographic price displays",
            "glowing, pulsating market indicators",
            "ethereal, translucent trading patterns",
            "crystalline, faceted chart formations",
            "dynamic, rippling price waves",
            "3D, volumetric depth charts",
            "fractal, recursive pattern displays"
        ];

        const colorSchemes = [
            "green and blue tones",
            "teal and gold highlights",
            "emerald and silver accents",
            "neon green and electric purple",
            "jade and amber hues",
            "aquamarine and fuchsia details",
            "lime and cyan patterns",
            "forest green and azure details",
            "mint and indigo highlights",
            "seafoam and violet accents"
        ];

        const sellColorSchemes = [
            "red and purple tones",
            "crimson and sapphire highlights",
            "ruby and silver accents",
            "scarlet and midnight blue",
            "fire orange and deep burgundy",
            "magenta and gold details",
            "cherry red and teal patterns",
            "wine red and electric blue details",
            "vermilion and indigo highlights",
            "garnet and azure accents"
        ];

        const profitableColorSchemes = [
            "vibrant green and gold tones",
            "emerald and platinum highlights",
            "jade and amber accents",
            "forest green and royal purple",
            "mint and azure hues",
            "lime and silver details",
            "olive and turquoise patterns",
            "seafoam and magenta details",
            "teal and yellow highlights",
            "aquamarine and rose gold accents"
        ];

        const detailElements = [
            "intricate mechanical gears, pipes, wires, and technical circuitry",
            "complex digital nodes, neural networks, and data flows",
            "elaborate crystalline structures, energy fields, and light rays",
            "detailed circuit boards, microchips, and quantum particles",
            "sophisticated blockchain cubes, cryptographic symbols, and hash patterns",
            "ornate technological fractals, energy streams, and data clusters",
            "intricate fiber optic webs, holographic displays, and digital portals",
            "complex matrix patterns, energy vortexes, and quantum waves",
            "detailed nano-machinery, digital scaffolding, and light grids",
            "elaborate tech-organic hybrids, energy pulses, and data crystals"
        ];

        const visualElements = [
            "abstract coin shapes and cryptocurrency symbols",
            "digital asset tokens and blockchain fragments",
            "geometric wealth symbols and value indicators",
            "crystalline currency forms and virtual value tokens",
            "holographic coin projections and digital wealth icons",
            "abstract crypto-value shapes and digital currency elements",
            "quantum finance particles and blockchain unit symbols",
            "virtual asset holograms and digital exchange tokens",
            "cyber-financial emblems and blockchain nodes",
            "tokenized value fragments and decentralized currency forms"
        ];

        const artStyles = [
            "high contrast and visual complexity",
            "vibrant digital surrealism",
            "futuristic techno-minimalism",
            "cyber-organic fusion",
            "quantum impressionism",
            "digital baroque intricacy",
            "neo-futurist precision",
            "hyper-detailed tech-noir",
            "abstract digital expressionism",
            "crystalline techno-cubism"
        ];

        // Random selection function
        const randomPick = (array: string[]) => array[Math.floor(Math.random() * array.length)];

        // Create a dynamic prompt based on trade action type (buy or sell)
        let imagePrompt = "";

        if (tradeData.action === "BUY") {
            // For BUY transactions
            const background = randomPick(backgroundStyles);
            const chart = randomPick(chartStyles);
            const colors = randomPick(colorSchemes);
            const details = randomPick(detailElements);
            const visuals = randomPick(visualElements);
            const style = randomPick(artStyles);

            imagePrompt = `Create a digital art representation of a cryptocurrency BUY order for ${tradeData.token} with absolutely NO text, NO letters, NO numbers, NO words, NO alphanumeric characters, NO symbols that resemble text. Important: ONLY visual elements allowed like trading candles, charts, and other related visual elements.

The image should feature: An upward trending chart with ${chart} on a ${background}. Include ${visuals} rising/floating upward, surrounded by ${details} in ${colors}. Use ${style} to create a sense of opportunity and market entry. The composition must be purely visual with no text-like elements whatsoever.`;
        } else {
            // For SELL transactions
            const isProfitable = tradeData.profitPercent && parseFloat(tradeData.profitPercent.replace('%', '')) > 0;

            const background = randomPick(backgroundStyles);
            const chart = randomPick(chartStyles);
            // Choose color scheme based on profitability
            const colors = isProfitable ? randomPick(profitableColorSchemes) : randomPick(sellColorSchemes);
            const details = randomPick(detailElements);
            const visuals = randomPick(visualElements);
            const style = randomPick(artStyles);
            const sentiment = isProfitable ? "accomplishment and success" : "closure and transition";

            imagePrompt = `Create a digital art representation of a cryptocurrency SELL order for ${tradeData.token} with absolutely NO text, NO letters, NO numbers, NO words, NO alphanumeric characters, NO symbols that resemble text. Important: ONLY visual elements allowed.

The image should feature: A completed chart pattern with ${chart} on a ${background}. Include ${visuals} with a sense of completion/finality, surrounded by ${details} in ${colors}. Use ${style} to create a sense of ${sentiment}. The composition must be purely visual with no text-like elements whatsoever.`;
        }

        elizaLogger.logColorful("Trade image prompt:", imagePrompt);

        const generatedImage = await generateImage(
            {
                prompt: imagePrompt,
                width: 1200,
                height: 675,
                numIterations: 50,
                guidanceScale: 5,
                seed: Math.floor(Math.random() * 1000), // Random seed for variety
                stylePreset: "photographic"
            },
            runtime
        );

        elizaLogger.logColorful("Generated trade image success:", generatedImage.success);
        if (generatedImage.success && generatedImage.data && generatedImage.data.length > 0) {
            elizaLogger.logColorful("Generated trade image data success:");
            // Import the saveBase64Image function from the image-generation plugin
            const { saveBase64Image } = await import("@elizaos/plugin-image-generation");
            const imagePath = await saveBase64Image(
                generatedImage.data[0],
                `trade_${tradeData.action.toLowerCase()}_${tradeData.token.toLowerCase()}_${Date.now()}`
            );
            elizaLogger.log(`Successfully generated and saved ${tradeData.action} trade image for ${tradeData.token} at: ${imagePath}`);
            return imagePath;
        } else {
            elizaLogger.error(`Failed to generate ${tradeData.action} trade image for ${tradeData.token}`, generatedImage.error);
            return null;
        }
    } catch (error) {
        elizaLogger.error(`Error generating ${tradeData.action} trade image for ${tradeData.token}:`, error);
        return null;
    }
};

// Helper function to format numbers with K, M, B suffixes
function formatNumber(num: number): string {
    if (num >= 1000000000) {
        return (num / 1000000000).toFixed(1) + 'B';
    }
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

/**
 * Generate an image for a Solana swap action
 * @param runtime The runtime environment
 * @param swapData The swap data
 * @param twitterService The Twitter service
 * @returns True if the image was generated successfully, false otherwise
 */
const generateImageForSolanaSwapAction = async (
    runtime: IAgentRuntime,
    swapData: TradeAlert,
    twitterService?: TwitterService
): Promise<boolean> => {
    try {
        elizaLogger.logColorful(`🔄 Handling ${swapData.action} swap for ${swapData.token}...`);

        // Step 1: Generate swap image
        const swapImage = await generateTradeSwapImage(runtime, swapData);

        if (!swapImage) {
            elizaLogger.error(`Failed to generate swap image for ${swapData.token}`);
            return false;
        }

        // Step 2: Tweet the image if Twitter service is available
        if (twitterService) {
            const tweetSuccess = await tweetTradeSwapImage(
                swapImage,
                swapData,
                twitterService,
                runtime
            );

            if (!tweetSuccess) {
                elizaLogger.warn(`Failed to tweet swap image for ${swapData.token}, but image was generated`);
                // Continue execution as image generation was successful
            }
        } else {
            elizaLogger.warn("Twitter service not available, skipping tweet");
        }

        elizaLogger.logColorful(`✅ Successfully handled ${swapData.action} swap for ${swapData.token}`);
        return true;
    } catch (error) {
        elizaLogger.error(`Error handling Solana swap action for ${swapData.token}:`, error);
        return false;
    }
};

/**
 * Tweet a trade swap image
 * @param imagePath The path to the image file
 * @param tradeData The trade data
 * @param twitterService The Twitter service
 * @returns True if the image was tweeted successfully, false otherwise
 */
const tweetTradeSwapImage = async (
    imagePath: string,
    tradeData: TradeAlert,
    twitterService?: TwitterService,
    runtime?: IAgentRuntime
): Promise<boolean> => {
    try {
        if (!twitterService) {
            elizaLogger.error("Cannot tweet trade image: Twitter service is not available");
            return false;
        }

        if (!imagePath || !fs.existsSync(imagePath)) {
            elizaLogger.error("Cannot tweet trade image: Image not found at path", imagePath);
            return false;
        }

        // Select appropriate messages based on whether it's a BUY or SELL
        let tweetMessage = "";
        const { action, token, price, profitPercent, profitUsd, trustScore, marketData, reason } = tradeData;

        if (action === "BUY") {
            // BUY message templates
            const buyMessages = [
                `🎯 $${token} | Just bought at $${price.toFixed(6)} | Trust: ${Math.round((trustScore || 0) * 100)}% #SolanaTrading #CryptoAlert #TradingBot #AITrading #AlgoTrading #GenerativeArt`,
                `💰 Added $${token} to the portfolio at $${price.toFixed(6)} | Bot confidence: ${Math.round((trustScore || 0) * 100)}% #Solana #CryptoTrading #AITrader #AlgoArt #DataVisualization`,
                `⚡ New position: $${token} | Entry: $${price.toFixed(6)} | Algorithmic analysis shows potential #AITrading #CryptoTrading #SolanaGems #TradingBot #CryptoArt`,
                `🧠 AI algorithm detected $${token} as a high potential buy at $${price.toFixed(6)} #CryptoBot #AlgorithmicTrading #SolanaPumps #TechArt #GenerativeArt`,
                `🚀 Taking a position in $${token} at $${price.toFixed(6)} | Market data looks promising #CryptoSignals #Solana #AlgoTrading #AIArt #DataArt`
            ];

            // Select a random message
            tweetMessage = buyMessages[Math.floor(Math.random() * buyMessages.length)];

            if (marketData && marketData.volume24h && marketData.volume24h > 0) {
                tweetMessage += `\n24h Volume: $${formatNumber(marketData.volume24h)}`;
            }
        } else {
            // SELL message templates - adjust based on profit/loss
            const isProfitable = profitPercent && parseFloat(profitPercent.replace('%', '')) > 0;

            if (isProfitable) {
                // Profitable sell messages
                const profitMessages = [
                    `💎 Profit locked! Sold $${token} at $${price.toFixed(6)} for ${profitPercent} gain ${profitUsd ? `($${profitUsd})` : ''} #TradingSuccess #Solana #CryptoTrading #AITrading #AlgoArt #DataVisualization`,
                    `🔥 Position closed: $${token} | Exit: $${price.toFixed(6)} | Result: +${profitPercent} ${profitUsd ? `($${profitUsd})` : ''} #ProfitSecured #AITrader #CryptoTrading #AlgorithmicArt #GenerativeArt`,
                    `💰 Trade completed: $${token} sold for ${profitPercent} profit ${profitUsd ? `($${profitUsd})` : ''} | Bot is working! #CryptoBot #Solana #TradingStrategy #TradingArt #AIArt`,
                    `🎯 Target reached for $${token}! +${profitPercent} profit ${profitUsd ? `($${profitUsd})` : ''} | Algorithmic precision at work #AlgoTrading #CryptoSignals #SolanaTrade #GenerativeArt #TechArt`,
                    `📈 Successful exit from $${token} with ${profitPercent} gains ${profitUsd ? `($${profitUsd})` : ''} | AI trading edge demonstrated #AITrading #CryptoBot #SolanaProfit #AlgoArt #DataVisualization`
                ];

                // Select a random message
                tweetMessage = profitMessages[Math.floor(Math.random() * profitMessages.length)];
            } else {
                // Loss or break-even messages
                const lossMessages = [
                    `🔄 Position closed: $${token} | Exit: $${price.toFixed(6)} | Result: ${profitPercent} ${profitUsd ? `($${profitUsd})` : ''} #RiskManagement #AITrading #CryptoTrading #DataArt #AlgorithmicArt`,
                    `⚠️ Trade exit: $${token} sold at $${price.toFixed(6)} | ${profitPercent} ${profitUsd ? `($${profitUsd})` : ''} | Moving on to better opportunities #TradingStrategy #CryptoBot #Solana #GenerativeArt #TechArt`,
                    `🛡️ Risk management activated: Exited $${token} position at ${profitPercent} ${profitUsd ? `($${profitUsd})` : ''} #CryptoRiskManagement #AITrader #AlgoTrading #AIArt #TradingVisualization`,
                    `📊 Strategy defense: Closed $${token} position at ${profitPercent} ${profitUsd ? `($${profitUsd})` : ''} | Capital preservation is key #TradingPsychology #AIAlgorithm #SolanaTrading #DataArt #CryptoArt`
                ];

                // Select a random message
                tweetMessage = lossMessages[Math.floor(Math.random() * lossMessages.length)];
            }

            // Add reason if available
            if (reason) {
                tweetMessage += `\nReason: ${reason}`;
            }
        }

        // Add common hashtags
        tweetMessage += `\n\n#TinyCoinTrader #SolanaTrading #CryptoBot #AITrading #AlgoArt`;

        // Upload the image to ImgBB
        const imageUrl = await uploadImageToImgBB(imagePath, runtime);
        if (!imageUrl) {
            elizaLogger.error("Failed to upload trade image to ImgBB for tweeting");
            return false;
        }

        // Now tweet with the image URL included in the message
        const finalTweetMessage = `${tweetMessage}\n\n${imageUrl}`;

        // Post to Twitter
        const success = await twitterService.tweetGeneric(finalTweetMessage);

        if (success) {
            elizaLogger.log(`Successfully tweeted ${action} trade image for ${token}`);
            return true;
        } else {
            elizaLogger.error(`Failed to tweet ${action} trade image for ${token}`);
            return false;
        }
    } catch (error) {
        elizaLogger.error("Error tweeting trade swap image:", error);
        return false;
    }
};

/**
 * Generate a branding image for Tiny Coin Trader
 * @param runtime The runtime environment
 * @param message The message to generate the image from
 * @returns The path to the generated image, or null if the generation fails
 */
const generateTradingBrandingImage = async (runtime: IAgentRuntime, message: Memory): Promise<string | null> => {
    try {
        elizaLogger.logColorful("Generating Tiny Coin Trader branding image...");

        if (!runtime) {
            elizaLogger.error("Cannot generate image: runtime is undefined");
            return null;
        }

        // Arrays of dynamic options for branding image variety
        const backgroundStyles = [
            "abstract background with neon blue and purple lines",
            "futuristic digital landscape with cyan and magenta glows",
            "deep space backdrop with vibrant nebula-like colors",
            "geometric grid pattern with electric blue and violet hues",
            "digital matrix environment with teal and crimson highlights",
            "abstract technological void with pulsating amber and indigo",
            "cyberspace terrain with neon green and royal purple waves",
            "quantum data field with sapphire and ruby particles",
            "holographic plane with turquoise and pink reflections",
            "fractal dimension with emerald and fuchsia patterns"
        ];

        const tradingVisuals = [
            "trading candlestick patterns",
            "dynamic price charts and graphs",
            "flowing market depth visualizations",
            "geometric trading indicators",
            "abstract bull and bear market symbols",
            "momentum wave patterns",
            "fractal trading patterns",
            "algorithmic trading visualizations",
            "market cycle spirals",
            "technical analysis formations"
        ];

        const cryptoIconography = [
            "cryptocurrency iconography (like abstract coin shapes)",
            "blockchain node structures and connections",
            "digital wallet representations",
            "cryptographic key symbols",
            "decentralized network visualizations",
            "tokenized asset forms",
            "mining and validation imagery",
            "peer-to-peer exchange motifs",
            "digital asset vault symbols",
            "consensus mechanism representations"
        ];

        const techDetails = [
            "intricate mechanical details - gears, pipes, wires, glowing tubes, and technical circuitry",
            "complex neural networks with synaptic connections",
            "advanced microprocessor architecture with quantum elements",
            "sophisticated AI algorithmic structures with data flows",
            "detailed blockchain technology with interlinked blocks and hashes",
            "elaborate digital interfaces with holographic controls",
            "intricate crypto-mining rigs with cooling systems and processing units",
            "complex trading terminals with real-time data visualization",
            "detailed quantum computing elements with entangled particles",
            "advanced technological infrastructure with energy conduits and data centers"
        ];

        const visualStyles = [
            "high contrast and visual complexity to create a surreal atmosphere",
            "vibrant color gradients with futuristic light sources",
            "sleek minimalist design with strategic accent highlights",
            "hyper-detailed technological realism with precise connections",
            "neo-digital abstract expressionism with emotional data flows",
            "cyber-organic fusion where technology meets natural forms",
            "dystopian tech-noir with dramatic lighting and shadows",
            "quantum-inspired fractal complexity with recursive patterns",
            "holographic depth with translucent layered elements",
            "cinematic tech visualization with dramatic perspective"
        ];

        const atmospheres = [
            "suggesting advanced technology and futuristic machinery",
            "evoking the power of algorithmic intelligence",
            "conveying the precision of automated trading systems",
            "portraying the dynamic world of digital finance",
            "illustrating the complexity of market analysis",
            "representing the frontier of financial technology",
            "capturing the essence of computational trading",
            "reflecting the evolution of digital currencies",
            "embodying the synergy between AI and markets",
            "expressing the cutting edge of trading innovation"
        ];

        // Reuse the randomPick function from the prior code, or define it if needed
        const randomPick = (array: string[]) => array[Math.floor(Math.random() * array.length)];

        // Select random elements from each array
        const background = randomPick(backgroundStyles);
        const tradingVisual = randomPick(tradingVisuals);
        const cryptoIcons = randomPick(cryptoIconography);
        const techDetail = randomPick(techDetails);
        const visualStyle = randomPick(visualStyles);
        const atmosphere = randomPick(atmospheres);

        // Construct the dynamic prompt
        const imagePrompt = `Create a digital art representation of this data ${message.content.text} for stock trading and cryptocurrency trading with absolutely NO text, NO letters, NO numbers, NO words, NO alphanumeric characters, NO symbols that resemble text. Important: ONLY visual elements allowed.

The image should feature trading candles and these elements: ${background}, ${tradingVisual}, ${cryptoIcons}, surrounded by ${techDetail}. Use ${visualStyle} ${atmosphere}. The composition must be purely visual with no text-like elements whatsoever.`;
        elizaLogger.logColorful("Image prompt:", imagePrompt);

        const generatedImage = await generateImage(
            {
                prompt: imagePrompt,
                width: 1200,
                height: 675,
                numIterations: 50,
                guidanceScale: 5,
                seed: Math.floor(Math.random() * 1000), // Random seed for variety
                stylePreset: "photographic"
            },
            runtime
        );

        elizaLogger.logColorful("Generated image success:", generatedImage.success);
        if (generatedImage.success && generatedImage.data && generatedImage.data.length > 0) {
            elizaLogger.logColorful("Generated image data hit***********************************:");
            // Import the saveBase64Image function from the image-generation plugin
            const { saveBase64Image } = await import("@elizaos/plugin-image-generation");
            const state: State = await runtime.composeState(message);
            const imagePath = await saveBase64Image(generatedImage.data[0], `tiny_coin_trader_img_gen_${Date.now()}`);
            elizaLogger.logColorful("Generated image path hit***********************************:");
            elizaLogger.log(`Successfully generated and saved Tiny Coin Trader branding image at: ${imagePath}`);
            return imagePath as string;
        } else {
            elizaLogger.error("Failed to generate Tiny Coin Trader branding image", generatedImage.error);
            return null;
        }
    } catch (error) {
        elizaLogger.error("Error generating Tiny Coin Trader branding image:", error);
        return null;
    }
};

/**
 * Upload an image to ImgBB
 * @param imagePath The path to the image file
 * @param runtime The runtime environment to access settings
 * @returns The URL of the uploaded image, or null if the upload fails
 */
const uploadImageToImgBB = async (imagePath: string, runtime?: IAgentRuntime): Promise<string | null> => {
    try {
        if (!imagePath || !fs.existsSync(imagePath)) {
            elizaLogger.error("Cannot upload to ImgBB: Image not found at path", imagePath);
            return null;
        }

        // Upload the image to ImgBB
        elizaLogger.logColorful("Uploading image to ImgBB...");
        const imgBBApiKey = runtime?.getSetting("IMGBB_API_KEY") || "NO_API_KEY_FOUND"; // Use env var with fallback
        const expirationInSeconds = 30 * 24 * 60 * 60; // 30 days
        const imgBBUrl = `https://api.imgbb.com/1/upload?expiration=${expirationInSeconds}&key=${imgBBApiKey}`;

        // Read the image file as base64
        const imageBuffer = fs.readFileSync(imagePath);
        const base64Image = imageBuffer.toString('base64');

        // Prepare the form data for ImgBB
        const formDataObj = {
            image: base64Image.substring(0, 20) + '...[truncated]', // Only log part of the base64 to avoid huge logs
            filename: path.basename(imagePath)
        };
        elizaLogger.logColorful("FormData object:", formDataObj);
        const params = new URLSearchParams();
        params.append('image', base64Image);
        params.append('name', path.basename(imagePath));

        // Upload to ImgBB
        elizaLogger.logColorful("Uploading image to ImgBB...");
        elizaLogger.logColorful("ImgBB URL:", imgBBUrl);
        const response = await fetch(imgBBUrl, {
            method: 'POST',
            body: params,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const imgbbData = await response.json();
        elizaLogger.logColorful("ImgBB response:", imgbbData);

        if (!imgbbData.success) {
            elizaLogger.error("Failed to upload image to ImgBB:", imgbbData);
            return null;
        }

        // Get the image URL from the response
        const imageUrl = imgbbData.data.url_viewer;
        elizaLogger.log("Successfully uploaded image to ImgBB:", imageUrl);
        return imageUrl;
    } catch (error) {
        elizaLogger.error("Error uploading image to ImgBB:", error);
        return null;
    }
};

/**
 * Tweet a branding image
 * @param imagePath The path to the image file
 * @param twitterService The Twitter service
 * @returns True if the image was tweeted successfully, false otherwise
 */
const tweetBrandingImage = async (
    imagePath: string,
    twitterService?: TwitterService,
    runtime?: IAgentRuntime
): Promise<boolean> => {
    try {
        if (!twitterService) {
            elizaLogger.error("Cannot tweet branding image: Twitter service is not available");
            return false;
        }

        const tweetMessages = [
            "🤖 Tiny Coin Trader is scanning the markets 24/7 for the best opportunities! #AI #TradingBot #Crypto #AlgoArt #GenerativeArt #AIArt",
            "📈 Let AI handle your trades while you focus on what matters. Tiny Coin Trader never sleeps! #AlgoTrading #Crypto #DigitalArt #AlgoArt",
            "💰 Smart trading decisions powered by advanced algorithms. Tiny Coin Trader at your service! #CryptoTrading #Solana #AlgorithmicArt #TechArt",
            "⚡ Lightning-fast execution, data-driven decisions. This is how we trade. #CryptoBot #AITrading #GenerativeArt #CryptoArt",
            "🧠 When human emotions fail, algorithms prevail. Trading with precision 24/7. #TradingBot #CryptoTrading #AIArt #AlgoTradingArt",
            "🚀 Navigating the crypto markets with algorithmic precision. #SolanaTrading #AITrader #TradingArt #DigitalArt",
            "📊 Making data-backed trading decisions for optimal returns. #AlgoTrading #TradingBot #DataArt #GenerativeDesign",
            "💼 Your automated trading companion in the volatile crypto market. #CryptoBot #AITrading #AlgoArt #TechVisualization",
            "🔍 Constantly analyzing market patterns to find the next opportunity. #TradingAlgorithm #Crypto #PatternArt #GenerativeArt",
            "⏱️ Trading never stops, and neither does Tiny Coin Trader. #24/7Trading #CryptoBot #DigitalArt #AlgoArt",
            // Market focus messages
            "🤖 Tiny Coin Trader is scanning crypto markets 24/7 for the best opportunities! #AI #TradingBot #Crypto #PassiveIncome #CryptoTrading #AlgoArt #TradingVisuals",
            "📈 $SOL and crypto trading on autopilot! Tiny Coin Trader never sleeps, constantly monitoring markets. #AlgoTrading #Crypto #TradingBot #Solana #DigitalArt #AlgoArt",
            "💰 Automated profit hunting in the #crypto markets. Tiny Coin Trader's algorithms work while you don't. #CryptoTrading #Solana #AlgoTrading #GenerativeArt #TechArt",
            "⚡ Lightning-fast execution, data-driven decisions. This is how we trade #crypto in 2025. #CryptoBot #AITrading #TradingAlgorithm #AlgorithmicArt #AIArt",

            // Technology focus messages
            "🧠 When human emotions fail, algorithms prevail. AI-powered trading precision 24/7 on #Solana. #TradingBot #CryptoTrading #ArtificialIntelligence #AIArt #DataVisualization",
            "🚀 Navigating the #SolanaEcosystem with algorithmic precision. Finding gems before they pump. #SolanaTrading #AITrader #CryptoGems #GenerativeArt #CryptoArt",
            "📊 Making data-backed trading decisions for optimal returns in volatile markets. #AlgoTrading #TradingBot #DataScience #QuantTrading #AlgoArt #DataArt",
            "💻 Our AI scans thousands of tokens per minute to find the next 100x gem on #Solana. #AITrading #CryptoBot #AltcoinSeason #SolanaSummer #AIArt #AlgorithmicArt",

            // Benefit focus messages
            "💼 Your automated trading companion in the volatile crypto market. Stop losing sleep over trades. #CryptoBot #AITrading #WorkSmarter #PassiveIncome #AlgoArt #CreativeCoding",
            "🔍 Pattern recognition AI constantly analyzing #Solana markets to find opportunities. #TradingAlgorithm #Crypto #MachineLearning #PatternArt #GenerativeArt",
            "⏱️ Trading never stops, and neither does Tiny Coin Trader. 24/7 market surveillance. #24/7Trading #CryptoBot #AlwaysOn #CryptoNeverSleeps #DigitalArt #AlgoTradingArt",
            "🎯 Precision entry and exit points calculated by advanced algorithms. No more emotional trading. #TechnicalAnalysis #CryptoTrading #AIAlgorithm #AlgorithmicArt #TechArt",

            // Audience-specific messages
            "🌙 While you sleep, our bot hunts for moonshots on #Solana. Wake up to profits, not more work. #CryptoMoonshot #PassiveIncome #SolanaGems #AIArt #GenerativeArt",
            "🛡️ Risk management protocols built into every trade. Smart crypto trading for uncertain times. #RiskManagement #CryptoSafety #SmartTrading #AlgoArt #DigitalArt",
            "📱 Crypto trading automation that works. No more checking charts every 5 minutes. #MobileTrading #CryptoLifestyle #DeFiTrading #TechArt #CreativeCode",
            "💸 DeFi liquidity analysis and token evaluation running 24/7 on #Solana. #DeFi #SolanaDeFi #LiquidityMining #TokenAnalysis #DataArt #AlgorithmicArt",

            // Trending-topic messages
            "⚙️ Tiny Coin Trader: The #Web3 approach to automated crypto trading on #Solana. #Web3Trading #CryptoAutomation #AITrading #CryptoArt #GenerativeDesign",
            "🌐 Blockchain trading algorithms spotting trends before they become obvious. #BlockchainTrading #CryptoTrends #SolanaTrading #AlgoArt #DataVisualization",
            "🔐 Secure, reliable, profitable. Tiny Coin Trader makes #crypto trading accessible to everyone. #CryptoForAll #AutomatedTrading #SolanaEcosystem #DigitalArt #AIArt",
            "🧿 AI-powered market sentiment analysis for better timing on #SolanaTokens. #MarketSentiment #AIAnalytics #TokenTrading #AlgorithmicArt #TechArt"
        ];

        // Select a random message
        const message = tweetMessages[Math.floor(Math.random() * tweetMessages.length)];
        elizaLogger.logColorful("Tweeting branding image with message:", message);

        // Now tweet with the image URL included in the message
        const tweetMessage = `${message}\n\n${imagePath}`;
        // Post to Twitter
        const success = await twitterService.tweetGeneric(tweetMessage);

        if (success) {
            elizaLogger.log("Successfully tweeted branding image");
            return true;
        } else {
            elizaLogger.error("Failed to tweet branding image");
            return false;
        }
    } catch (error) {
        elizaLogger.error("Error tweeting branding image:", error);
        return false;
    }
};

/**
 * Create the Tiny Coin Trader plugin
 * @param getSetting Get a setting from the runtime
 * @param runtime Runtime for state and other services
 * @returns The plugin
 */
export async function createTinyCoinTraderPlugin(
    getSetting: (key: string) => string | undefined,
    runtime?: IAgentRuntime
): Promise<Plugin> {
    elizaLogger.log("Starting createTinyCoinTraderPlugin plugin initialization");
    elizaLogger.logColorfulForDiscord(`Runtime clients searching for discord: ${runtime.clients}`);

    const resumeTrading = async () => {
    // Initialize Arbitrage system
    //const arbitrageConfig = {
    //    enabled: getSetting("ARBITRAGE_ENABLED") === "true",
    //    minProfitPercent: parseFloat(getSetting("ARBITRAGE_MIN_PROFIT") || "1.5"),
   //     maxSlippage: parseFloat(getSetting("ARBITRAGE_MAX_SLIPPAGE") || "0.5"),
    //    scanInterval: parseInt(getSetting("ARBITRAGE_SCAN_INTERVAL") || "30000"), // 30 seconds
    //    exchanges: (getSetting("ARBITRAGE_EXCHANGES") || "solana,jupiter").split(",")
    //};

    //let arbitrageManager: ArbitrageManager | null = null;
    //if (arbitrageConfig.enabled && runtime) {
    //    arbitrageManager = new ArbitrageManager(arbitrageConfig, runtime, walletProvider);
    //    await arbitrageManager.start();
    //}

    // Initialize long-term investment strategy
    //const longTermConfig = {
    //    enabled: getSetting("LONGTERM_ENABLED") === "true",
    //    allocatedPercentage: parseFloat(getSetting("LONGTERM_ALLOCATION") || "30"), // 30% of total funds
    //    rebalanceInterval: parseInt(getSetting("LONGTERM_REBALANCE_INTERVAL") || "604800000"), // 7 days
    //    maxPerAsset: parseFloat(getSetting("LONGTERM_MAX_PER_ASSET") || "10") // 10% max in any single asset
    //};

    //let longTermManager: LongTermManager | null = null;
    //if (longTermConfig.enabled && runtime) {
    //    longTermManager = new LongTermManager(longTermConfig, runtime, walletProvider);
    //    await longTermManager.start();
    //}

        // Initialize AI decision service
        //const aiDecisionService = new AIDecisionService(runtime);

        // Get new tokens from Airtable
        const pumpFunTokenAddresses = await fetchPumpFunTokensFromAirtable(runtime);
        elizaLogger.log(`Analyzing ${pumpFunTokenAddresses.length} SOLANA MEME COINS...`);

        for (const tokenAddress of pumpFunTokenAddresses) {
            let attempt = 0;
            let success = false;

            while (!success && attempt < 1) {
                try {
                    elizaLogger.log(`Analyzing token!!!!!!!!!!!!!!!!!!!!!!!!!!!!! ${tokenAddress.get('Mint')}:`);
                    const balance = await getTokenBalance(connection, keypair.publicKey, new PublicKey(tokenAddress.get('Mint') as string));

                    // Use shorter delay for held tokens, longer for new tokens
                    const delay = balance > 0 ? 1000 : 5500;  // 1s for held, 5.5s for new
                    await new Promise(resolve => setTimeout(resolve, delay));

                    // Check here to see if we have sufficient balance to buy else set all coins in the table to Stopped Monitoring
                    //const solBalance = await connection.getBalance(keypair.publicKey);
                    //const solBalanceInSol = solBalance / 1e9;
                    //if(solBalanceInSol < SAFETY_LIMITS.MINIMUM_TRADE){
                        //elizaLogger.log(`Insufficient balance to buy, setting all coins in the table to Stopped Monitoring`);
                        // Update all tokens in Airtable to Stopped Monitoring
                        //for (const token of pumpFunTokenAddresses) {
                        //    try {
                        //        elizaLogger.log(`Insufficient balance to buy, updating Airtable status for ${token.get('Mint')} to Stopped Monitoring`);
                        //        await updateAirtableStatus(token.id, "Stopped Monitoring", runtime, "PumpFunNewTokens");
                        //    } catch (error) {
                        //        elizaLogger.error(`Failed to update Airtable status for ${token.get('Mint')}:`, error);
                        //    }
                        //}
                        //return; // Exit the function
                    //}else {
                        await analyzeToken(
                            runtime,
                            connection,
                            twitterService,
                            //telegramService,
                            tokenAddress.get('Mint') as string
                        );
                        success = true;
                    //}
                } catch (error) {
                    if (error.message?.includes('429')) {  // Rate limit error
                        attempt++;
                        const delay = getRandomDelay(attempt);
                        elizaLogger.warn(`Rate limit hit, attempt ${attempt}/3. Waiting ${delay}ms before retry`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        elizaLogger.error(`Error analyzing token!!!!!!!!!!!!!!!!!!!!!! ${tokenAddress.get('Mint')}:`, error);
                    }
                }
            }

            // Add varying delay between tokens
            const betweenTokensDelay = 1000 + Math.random() * 2000;  // 2-4 seconds
            await new Promise(resolve => setTimeout(resolve, betweenTokensDelay));
        }

        // Shorter delay between full cycles
        await new Promise((resolve) => setTimeout(resolve, 60 * 1000)); // 60 seconds
    };

    const monitorTheShitOutOfBoughtTokens = async () => {
        elizaLogger.log(`Starting monitorTheShitOutOfBoughtTokens----------------`);
            const pumpFunTokenAddresses = await fetchBoughtAndHoldingPumpFunTokensFromAirtable(runtime);
            elizaLogger.log(`Analyzing bought and holding ${pumpFunTokenAddresses.length} SOLANA MEME COINS...`);

            if (pumpFunTokenAddresses.length === 0) {
                ACTIVE_MONITORING_INTERVAL = 120 * 1000;   // 120 seconds
                elizaLogger.log("No bought and holding tokens found");
                return;
            }else{
                ACTIVE_MONITORING_INTERVAL = 20 * 1000;   // 20 seconds
            }
            elizaLogger.log(`ACTIVE_MONITORING_INTERVAL: ${ACTIVE_MONITORING_INTERVAL}`);

            for (const tokenAddress of pumpFunTokenAddresses) {
                let attempt = 0;
                let success = false;

                while (!success && attempt < 1) {
                    try {
                        elizaLogger.log(`Analyzing bought and holding token!!!!!!!!!!!!!!!!!!!!!!!!!!!!! ${tokenAddress.get('Mint')}:`);
                        const balance = await getTokenBalance(connection, keypair.publicKey, new PublicKey(tokenAddress.get('Mint') as string));

                        // Use shorter delay for held tokens, longer for new tokens
                        const delay = balance > 0 ? 800 : 6500;  //0.8s for held, 6.5s
                        await new Promise(resolve => setTimeout(resolve, delay));
                            await analyzeTokenForBoughtAndHolding(
                                runtime,
                                connection,
                                twitterService,
                                //telegramService,
                                tokenAddress.get('Mint') as string
                            );
                            success = true;
                        //}
                    } catch (error) {
                        if (error.message?.includes('429')) {  // Rate limit error
                            attempt++;
                            const delay = getRandomDelay(attempt);
                            elizaLogger.warn(`Rate limit hit, attempt ${attempt}/3. Waiting ${delay}ms before retry`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                        } else {
                            elizaLogger.error(`Error analyzing bought and holding token!!!!!!!!!!!!!!!!!!!!!! ${tokenAddress.get('Mint')}:`, error);
                        }
                    }
                }

                // Add varying delay between tokens
                const betweenTokensDelay = 1000 + Math.random() * 2000;  // 2-4 seconds
                await new Promise(resolve => setTimeout(resolve, betweenTokensDelay));
            }

            // Shorter delay between full cycles
            await new Promise((resolve) => setTimeout(resolve, 60 * 1000)); // 60 seconds
    };

    const connection = new Connection(
        runtime?.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
    );

    const keypair = getWalletKeypair(runtime);

    elizaLogger.log("Initializing Solana connection...");
    walletProvider = {
        connection,
        getChain: () => ({ type: "solana" }),
        getAddress: () => keypair.publicKey.toBase58(),
        signMessage: async (message: string): Promise<Signature> => {
            throw new Error(
                "Message signing not implemented for Solana wallet"
            );
        },
        balanceOf: async (tokenAddress: string): Promise<ExtendedBalance> => {
            try {
                if (tokenAddress.startsWith("0x")) {
                    // Handle Base token balance
                    const baseBalance = await getChainBalance(
                        connection,
                        keypair.publicKey,
                        tokenAddress
                    );
                    return {
                        value: BigInt(baseBalance.toString()),
                        decimals: 18, // Base uses 18 decimals
                        formatted: (baseBalance / 1e18).toString(),
                        symbol: "ETH",
                        name: "Base",
                    };
                } else {
                    // Existing Solana logic
                    const tokenPublicKey = new PublicKey(tokenAddress);
                    const amount = await getTokenBalance(
                        connection,
                        keypair.publicKey,
                        tokenPublicKey
                    );
                    return {
                        value: BigInt(amount.toString()),
                        decimals: 9,
                        formatted: (amount / 1e9).toString(),
                        symbol: "SOL",
                        name: "Solana",
                    };
                }
            } catch (error) {
                return {
                    value: BigInt(0),
                    decimals: tokenAddress.startsWith("0x") ? 18 : 9,
                    formatted: "0",
                    symbol: tokenAddress.startsWith("0x") ? "ETH" : "SOL",
                    name: tokenAddress.startsWith("0x") ? "Base" : "Solana",
                };
            }
        },
        getMaxBuyAmount: async (tokenAddress: string) => {
            try {
                if (tokenAddress.startsWith("0x")) {
                    // Handle Base chain balance
                    const baseBalance = await getChainBalance(
                        connection,
                        keypair.publicKey,
                        tokenAddress
                    );
                    return (baseBalance * 0.9) / 1e18; // Base uses 18 decimals
                } else {
                    // Handle Solana balance
                    const balance = await connection.getBalance(
                        keypair.publicKey
                    );
                    return (balance * 0.9) / 1e9; // Solana uses 9 decimals
                }
            } catch (error) {
                elizaLogger.error(
                    `Failed to get max buy amount for ${tokenAddress}:`,
                    error
                );
                return 0;
            }
        },
        executeTrade: async (params) => {
            try {
                return { success: true };
            } catch (error) {
                throw error;
            }
        },
        getFormattedPortfolio: async () => "",
    };

    elizaLogger.log(
        "Solana connection and wallet provider initialized successfully"
    );


    try {
        // TWITTER ///////////////////////////////////////////////////////////////////
        elizaLogger.log(
            "Configuring Twitter service for trade notifications..."
        );
        const twitterConfig = TwitterConfigSchema.parse({
            enabled: getSetting("TWITTER_ENABLED") === "true",
            username: getSetting("TWITTER_USERNAME"),
            dryRun: false,
        });

        if (twitterConfig.enabled && runtime) {
            elizaLogger.log("Starting Twitter client initialization...");
            const twitterClient = await TwitterClientInterface.start(runtime);
            twitterService = new TwitterService(twitterClient, twitterConfig);

            // Add delay after initialization
            await new Promise((resolve) => setTimeout(resolve, 5000));

            elizaLogger.log("Twitter service initialized successfully", {
                username: twitterConfig.username,
                dryRun: twitterConfig.dryRun,
            });
        }

        // TELEGRAM ///////////////////////////////////////////////////////////////////
        //elizaLogger.log(
        //    "Configuring Telegram service for trade notifications..."
        //);

        //const telegramBotToken = getSetting("TELEGRAM_BOT_TOKEN");
        //elizaLogger.log(`Telegram bot token available: ${!!telegramBotToken}`);

        //  if (!telegramBotToken) {
        //    elizaLogger.error("Cannot initialize Telegram: TELEGRAM_BOT_TOKEN is not set in environment");
        //} else {
        //    const telegramConfig: TelegramConfig = {
        //        TELEGRAM_BOT_TOKEN: telegramBotToken
        //    };

        //    try {
        //        elizaLogger.log("Starting Telegram client initialization...");
        //        const telegramClient = await TelegramClientInterface.start(runtime);

        //    if (!telegramClient) {
        //        elizaLogger.error("Telegram client initialization failed: client is null or undefined");
        //    } else {
        //        elizaLogger.log("Telegram client initialized successfully, creating service...");
        //        telegramService = new TelegramService(telegramClient, telegramConfig);

        //        // Add a small delay for initialization
        //        await new Promise((resolve) => setTimeout(resolve, 2000));

                    // Test if the service is properly initialized
        //        elizaLogger.log("Telegram service created:", {
        //            defined: !!telegramService,
        //            hasClient: telegramService && !!(telegramService['client'])
        //        });
        //    }
        //} catch (telegramError) {
        //    elizaLogger.error("Error initializing Telegram service:", {
        //        error: telegramError instanceof Error ? telegramError.message : String(telegramError),
        //        stack: telegramError instanceof Error ? telegramError.stack : undefined
        //    });
        //}


        // DISCORD ///////////////////////////////////////////////////////////////////
        //elizaLogger.logColorfulForDiscord("Checking for Discord configuration...");

        //const discordChannelId = getSetting("DISCORD_CHANNEL_ID");
        //elizaLogger.logColorfulForDiscord(`Discord channel ID available: ${!!discordChannelId}`);

        //if (!discordChannelId) {
        //    elizaLogger.error("Discord notifications will not be available: DISCORD_CHANNEL_ID is not set in environment");
        //} else {
        //    // Check if Discord client is already initialized in the runtime
        //    if (runtime.clients?.discord) {
        //        elizaLogger.logColorfulForDiscord("Discord client found in runtime, will use for sending messages");
        //    } else {
        //        const discordClient = await DiscordClientInterface.start(runtime);
        //        if (discordClient) {
        //            runtime.clients.discord = discordClient;
        //        }
        //        elizaLogger.logColorfulForDiscord(`Discord client not found in runtime, initialized: ${runtime.clients.discord}`);
        //    }
        //}
    } catch (error) {
        elizaLogger.error("Failed to initialize messaging services:", error);
    }

    elizaLogger.log("Initializing Solana plugin components...");

    try {
        const customActions = actions;

        // Then update the plugin creation
        const plugin: ExtendedPlugin = {
            name: "[Tiny Coin Trader] Onchain Actions with Solana Integration",
            description: "Autonomous trading integration with AI analysis",
            evaluators: [trustEvaluator, ...(solanaPlugin.evaluators || [])],
            providers: [
                walletProvider,
                trustScoreProvider,
                ...(solanaPlugin.providers || []),
            ],
            actions: [
                ...customActions,
                ...(solanaPlugin.actions || []),
                //...(agentKitPlugin.actions || [])
            ],
            services: [],
            autoStart: true,
        };

        // Add auto-start trading analysis
        if (!runtime) return;

        elizaLogger.log("Starting autonomous trading system...");
        const analyzeTradeAction = plugin.actions.find(
            (a) => a.name === "ANALYZE_TRADE"
        );

        if (!analyzeTradeAction) return;

        const interval = Number(60 * 1000); // 1 minute

        // Then start trading loop if enabled
        if (!settings.ENABLE_TRADING) return;


        (async () => {
            try {
                elizaLogger.log("Initializing Solana trading loop...");
                await resumeTrading();
                setInterval(() => resumeTrading(), interval);
                elizaLogger.log("Solana trading initialization and scheduling complete");
            } catch (error) {
                elizaLogger.error("Solana trading initialization failed:", error);
                // Failure here won't block the FreqTrade system
            }
        })();

        /*
        (async () => {
            try {
                elizaLogger.log("Initializing FreqTrade system...");
                await runFreqTrade(runtime, twitterService, getSetting);
                setInterval(() => runFreqTrade(runtime, twitterService, getSetting), 14400000);
                elizaLogger.log("FreqTrade initialization and scheduling complete");
            } catch (error) {
                elizaLogger.error("FreqTrade initialization failed:", error);
            }
        })();
        */

        (async () => {
            try {
                elizaLogger.log("Initializing position monitoring system...");
                await monitorTheShitOutOfBoughtTokens();
                setInterval(() => monitorTheShitOutOfBoughtTokens(), ACTIVE_MONITORING_INTERVAL);
                elizaLogger.log("Position monitoring initialization and scheduling complete");
            } catch (error) {
                elizaLogger.error("Position monitoring initialization failed:", error);
                // Failure here won't block other systems
            }
        })();

        (async () => {
            try {
                elizaLogger.logBitcoin("Initializing Bitcoin block monitoring system...");
                await checkForLatestMinedBlocks(twitterService);
                setInterval(() => checkForLatestMinedBlocks(twitterService), 360000); // 6 minutes = 360,000 ms
                elizaLogger.logBitcoin("Bitcoin block monitoring initialization and scheduling complete");
            } catch (error) {
                elizaLogger.error("Bitcoin block monitoring initialization failed:", error);
                // Failure here won't block other systems
            }
        })();

        /*(async () => {
            try {
                elizaLogger.log("Initializing AgentKit token processing system...");
                const processAgentkitTokens = async () => {
                    try {
                        const agentkitTokens = await fetchAgentkitTokensFromAirtable(runtime);

                        // Process tokens sequentially to avoid database contention
                        for (const tokenRecord of agentkitTokens) {
                            try {
                                await analyzeAgentkitToken(runtime, tokenRecord);
                            } catch (tokenError) {
                                elizaLogger.error(`Error analyzing token ${tokenRecord.tokenId}:`, tokenError);
                            }
                        }
                    } catch (error) {
                        elizaLogger.error("Error processing Agentkit tokens:", error);
                    }
                };

                // Initial run
                await processAgentkitTokens();

                // Set up recurring interval
                setInterval(processAgentkitTokens, interval);
                elizaLogger.log("AgentKit token processing initialization and scheduling complete");
            } catch (error) {
                elizaLogger.error("AgentKit token processing initialization failed:", error);
                // Failure here won't block other systems
            }
        })();*/

        (async () => {
            try {
                // Generate the image first
                const memory: Memory = {
                    userId: runtime.agentId,
                    agentId: runtime.agentId,
                    roomId: runtime.agentId,
                    content: {
                        text: "Generate branding image for Tiny Coin Trader",
                        type: "image_generation"
                    }
                };
                elizaLogger.logColorful("Generating branding image...");
                elizaLogger.logColorful("Memory for generateTradingBrandingImage:", memory);
                const imagePath = await generateTradingBrandingImage(runtime, memory);
                elizaLogger.logColorful("Image generated:", imagePath);
                if (imagePath) {
                    // Upload the image to ImgBB
                    const imageUrl = await uploadImageToImgBB(imagePath, runtime);
                    if (!imageUrl) {
                        elizaLogger.error("Failed to upload image to ImgBB for tweeting");
                        return false;
                    }

                    /*
                    // Mint the NFT
                    elizaLogger.logColorfulForSolanaNFT("Minting NFT...");
                    try {
                        await createNftFromImage(
                            runtime?.getSetting("WALLET_PRIVATE_KEY"),
                            imagePath,
                            "Tiny Coin Trader",
                            "Tiny Coin Trader is a trading bot that scans the markets 24/7 for the best opportunities!",
                            "TCT",
                            [
                                { trait_type: 'Speed', value: 'Quick' },
                            ],
                            connection
                        );
                        elizaLogger.logColorfulForSolanaNFT("NFT minted successfully");
                    } catch (error) {
                        elizaLogger.error("Failed to mint NFT:", error);
                        // Continue with the rest of the process even if NFT minting fails
                    }
                    setInterval(() => createNftFromImage(runtime?.getSetting("WALLET_PRIVATE_KEY"), imagePath, "Tiny Coin Trader", "Tiny Coin Trader is a trading bot that scans the markets 24/7 for the best opportunities!", "TCT", [
                            { trait_type: 'Speed', value: 'Quick' },
                        ]
                    ), 43200000);
                    elizaLogger.logColorfulForSolanaNFT("NFT minted successfully");
                    */

                    // Tweet the image
                    // Set up interval for tweeting every 12 hours (43,200,000 ms)
                    elizaLogger.logColorfulForSolanaNFT("Tweeting image...");
                    //await tweetBrandingImage(imageUrl, twitterService, runtime);
                    //setInterval(() => tweetBrandingImage(imageUrl, twitterService, runtime), 43200000);
                    //elizaLogger.logColorful("Scheduled branding image tweets every 12 hours");

                    // // Set up interval for sending discord message for branding image every 12 hours (43,200,000 ms)
                    // const discordChannelId = '';//getSetting("DISCORD_CHANNEL_ID");
                    // if (discordChannelId) {
                    //     // Generate a random message for Discord
                    //     const randomMessage = "🤖 Tiny Coin Trader is scanning the markets 24/7 for the best opportunities!";

                    //     // First message immediately
                    //     await sendDiscordMessageToChannel(randomMessage, imageUrl, discordChannelId, runtime);

                    //     // Then schedule for every 12 hours
                    //     setInterval(() => {
                    //         sendDiscordMessage(imageUrl, discordChannelId, runtime);
                    //     }, 43200000);

                    //     elizaLogger.logColorfulForDiscord("Scheduled branding image discord messages every 12 hours");
                    // } else {
                    //     elizaLogger.error("Could not schedule Discord messages: DISCORD_CHANNEL_ID not set");
                    // }
                } else {
                    elizaLogger.error("Could not set up scheduled branding tweets: missing image or Twitter service or Telegram service");
                }
            } catch (error) {
                elizaLogger.error("Failed to set up branding image tweeting:", error);
            }
        })();

        elizaLogger.log("GOAT plugin initialization completed successfully");
        return plugin;
    } catch (error) {
        elizaLogger.error("Failed to initialize plugin components:", error);
        throw new Error(
            `Plugin initialization failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Fetch token addresses from Airtable from multiple views
 * @param runtime Runtime for potential config access
 * @returns Array of token records from Airtable
 */
async function fetchPumpFunTokensFromAirtable(runtime?: IAgentRuntime) {
    try {
        const airtableBase: Airtable.Base = new Airtable({ apiKey: runtime?.getSetting("AIRTABLE_API_KEY") }).base(runtime?.getSetting("AIRTABLE_BASE_ID"));

        // Get tokens from first view
        const newCoins = await airtableBase('PumpFunNewTokens')
            .select({
                view: "Pump Fun New Creation Coins",
                maxRecords: 1000,
                fields: ["Mint"]
            })
            .all();

        // Get tokens from second view
        const trendingCoins = await airtableBase('PumpFunNewTokens')
            .select({
                view: "New Prospects",
                maxRecords: 1000,
                fields: ["Mint"]
            })
            .all();

        // Combine both results
        const tokenAddresses = [...newCoins, ...trendingCoins];

        elizaLogger.log(`Fetched ${tokenAddresses.length} Solana tokens (${newCoins.length} new, ${trendingCoins.length} trending) from Airtable`);

        return tokenAddresses;
    } catch (error) {
        elizaLogger.error("Error fetching tokens from Airtable:", error);
        throw error;
    }
}

/**
 * Fetch bought and holding token addresses from Airtable from multiple views
 * @param runtime Runtime for potential config access
 * @returns Array of token records from Airtable
 */
async function fetchBoughtAndHoldingPumpFunTokensFromAirtable(runtime?: IAgentRuntime) {
    try {
        const airtableBase: Airtable.Base = new Airtable({ apiKey: runtime?.getSetting("AIRTABLE_API_KEY") }).base(runtime?.getSetting("AIRTABLE_BASE_ID"));

        // Get tokens from first view
        const boughtAndHoldingCoins = await airtableBase('PumpFunNewTokens')
            .select({
                view: "Bought and Holding",
                maxRecords: 1000,
                fields: ["Mint"]
            })
            .all();
        const tokenAddresses = [...boughtAndHoldingCoins];

        elizaLogger.log(`Fetched ${tokenAddresses.length} bought and holding Solana tokens (${boughtAndHoldingCoins.length} from Airtable`);

        return tokenAddresses;
    } catch (error) {
        elizaLogger.error("Error fetching tokens from Airtable:", error);
        throw error;
    }
}

/**
 * Check if a token already has an active position
 * @param tokenAddress The token address to check
 * @param runtime Runtime for database access
 * @returns Object indicating whether to skip analysis and reasoning
 */
async function checkExistingPosition(tokenAddress: string, trustScoreDb: TrustScoreDatabase) {
    // Check for existing position first
    //const openTrades = await trustScoreDb.getOpenTrades(tokenAddress);
    const openTrades = await withDatabaseRetry<any>(() =>
        trustScoreDb.getOpenTrades(tokenAddress)
    );
    elizaLogger.log(`Pre-buy check for ${tokenAddress}:`, {
        openTradesCount: openTrades.length,
        trades: openTrades,
        timestamp: new Date().toISOString()
    });

    if (openTrades.length > 0) {
        elizaLogger.warn(`Skipping analysis: Active position exists for ${tokenAddress}`);
        return {
            shouldSkip: true,
            recommendation: "SKIP",
            confidence: 100,
            reasoning: "Position already exists, preventing re-entry"
        };
    }

    return {
        shouldSkip: false
    };
}

/**
 * Execute a database operation with retry logic
 * @param operation Function that performs database operation
 * @param maxRetries Maximum number of retries
 * @returns Result of the operation
 */
async function withDatabaseRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            // Check if it's a database connection error
            if (error.message?.includes("database connection is not open")) {
                const delay = Math.min(100 * Math.pow(2, attempt), 2000); // Exponential backoff: 100ms, 200ms, 400ms
                elizaLogger.warn(`Database connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error; // For non-database errors, rethrow immediately
        }
    }
    throw lastError; // If we exhausted all retries
}

/**
 * Check if a token has been traded recently and is within the reentry delay period
 * @param tokenAddress The token address to check
 * @param trustScoreDb The database instance
 * @returns Object indicating whether to skip analysis based on reentry delay
 */
async function checkReentryDelay(tokenAddress: string, trustScoreDb: TrustScoreDatabase) {
    //const recentTrades = await trustScoreDb.getRecentTrades(tokenAddress, SAFETY_LIMITS.REENTRY_DELAY);
    const recentTrades = await withDatabaseRetry<any>(() =>
        trustScoreDb.getRecentTrades(tokenAddress, SAFETY_LIMITS.REENTRY_DELAY)
    );

    if (recentTrades.length > 0) {
        const lastTrade = recentTrades[0];
        const timeSinceLastTrade = Date.now() - new Date(lastTrade.sell_timeStamp || lastTrade.buy_timeStamp).getTime();

        elizaLogger.log("Found trades for exact address match:", {
            searchedAddress: tokenAddress,
            foundTrades: recentTrades.map(t => ({
                address: t.token_address,
                buyTime: t.buy_timeStamp,
                sellTime: t.sell_timeStamp
            }))
        });

        return {
            shouldSkip: true,
            recommendation: "SKIP",
            confidence: 100,
            reasoning: `Re-entry delay active: Last trade was ${(timeSinceLastTrade / (60 * 60 * 1000)).toFixed(2)} hours ago`
        };
    }

    return {
        shouldSkip: false
    };
}

/**
 * Fetch and validate token data, ensuring required structures exist
 * @param tokenAddress The token address to fetch data for
 * @param runtime Runtime for database and logging access
 * @returns The processed token data or null if validation fails
 */
async function fetchAndValidateTokenData(tokenAddress: string, runtime: IAgentRuntime, tokenProvider: TokenProvider): Promise<ProcessedTokenData | null> {
    try {
        let tokenData = await tokenProvider.getProcessedTokenData();
        elizaLogger.log(`Token data fetched for ${tokenAddress}:`, tokenData);

        // Ensure tokenData exists with basic structure
        if (!tokenData) {
            tokenData = {} as ProcessedTokenData;
        }

        // Ensure dexScreenerData exists
        if (!tokenData.dexScreenerData) {
            tokenData.dexScreenerData = { pairs: [] };
        }

        if (!tokenData?.dexScreenerData?.pairs?.length) {
            elizaLogger.warn(`No market data available for ${tokenAddress}, removing from monitoring`);

            try {
                // Update airtable status
                await updateAirtableStatus(tokenAddress, "Processing Failed", runtime, "PumpFunNewTokens");
                elizaLogger.log(`Updated Airtable status for ${tokenAddress} to Processing Failed`);
                return null; // Validation failed
            } catch (error) {
                elizaLogger.error(`Failed to update Airtable status for ${tokenAddress}:`, error);
                return null; // Validation failed
            }
        }

        return tokenData; // Validation passed
    } catch (error) {
        elizaLogger.error(`Error fetching and validating token data for ${tokenAddress}:`, error);
        return null; // Error occurred
    }
}

/**
 * Evaluate token trust score and determine if monitoring should continue
 * @param tokenAddress The token address to evaluate
 * @param runtime Runtime for database and Airtable access
 * @returns The trust score or null if monitoring should be stopped
 */
async function evaluateTokenTrust(tokenAddress: string, runtime: IAgentRuntime): Promise<number | null> {
    try {
        let returnTrustScore = 0;
        const trustProvider = new TrustScoreProvider();
        const trustEvaluation = await trustProvider.evaluateToken(tokenAddress);

        const { trustScore } = trustEvaluation;
        returnTrustScore = trustScore;
        // If the evaluation signals that we should stop monitoring (e.g. token is trending down or rugged), update Airtable and exit
        if (trustEvaluation.stopMonitoring) {
            elizaLogger.warn(`Token ${tokenAddress} is trending downward or flagged as high risk. Stopping monitoring.`);
            //await updateAirtableStatus(tokenAddress, "Stopped Monitoring", runtime, "PumpFunNewTokens");
            //return null;
            returnTrustScore = -99.99;
        }

        return returnTrustScore;
    } catch (error) {
        elizaLogger.error(`Error evaluating trust score for ${tokenAddress}:`, error);
        return null;
    }
}

/**
 * Handle case where latestTrade is null by checking token balance
 * @param latestTrade The latest trade record (might be null)
 * @param tokenAddress The token address to check balance for
 * @param runtime Runtime for agent ID
 * @param connection Solana connection for balance checks
 * @param tokenData Processed token data for price information
 * @returns A trade record object, either the provided latestTrade or a newly created one
 */
async function handleNullLatestTrade(
    latestTrade: any,
    tokenAddress: string,
    runtime: IAgentRuntime,
    connection: Connection,
    tokenData: ProcessedTokenData,
    walletPublicKey: string
) {
    let tradeRecord = latestTrade;

    if (!latestTrade) {
        elizaLogger.log(`No latestTrade data found, checking current balance for ${tokenAddress}`);

        try {
            const tokenBalance = await getTokenBalance(
                connection,
                new PublicKey(walletPublicKey),
                new PublicKey(tokenAddress)
            );

            elizaLogger.log(`tokenBalance------ ${tokenBalance}`);

            // Convert BigInt to number first
            const tokenBalanceNumber = Number(tokenBalance.toString());
            const tokenAmount = tokenBalanceNumber / 1e9;  // Convert to human readable

            elizaLogger.log(`Formatted token amount for selling: ${tokenAmount}`);

            // Use actual price from when we first detected the token
            const pair = tokenData.dexScreenerData.pairs[0];
            const entryPrice = Number(pair?.priceUsd || 0);

            // Create synthetic trade record
            tradeRecord = {
                token_address: tokenAddress,
                recommender_id: runtime.agentId,
                buy_price: entryPrice,
                buy_amount: tokenAmount,
                buy_timeStamp: pair.pairCreatedAt || new Date().toISOString(),
                buy_market_cap: Number(pair?.marketCap || 0),
                buy_liquidity: Number(pair?.liquidity?.usd || 0),
                buy_value_usd: tokenAmount * entryPrice,
                sell_price: Number(pair?.priceUsd || 0),
                sell_timeStamp: new Date().toISOString(),
                sell_amount: tokenAmount,
                sell_value_usd: tokenAmount * Number(pair?.priceUsd || 0),
                sell_market_cap: Number(pair?.marketCap || 0),
                sell_liquidity: Number(pair?.liquidity?.usd || 0),
                profit_usd: tokenAmount * (Number(pair?.priceUsd || 0) - entryPrice),
                profit_percent: ((Number(pair?.priceUsd || 0) - entryPrice) / entryPrice) * 100,
                market_cap_change: 0,
                liquidity_change: 0,
                rapidDump: false
            };

            elizaLogger.log(`Created trade record:`, tradeRecord);
        } catch (error) {
            // Handle TokenAccountNotFoundError by creating a zero-balance record
            if (error.name === 'TokenAccountNotFoundError') {
                const pair = tokenData.dexScreenerData.pairs[0];
                const currentPrice = Number(pair?.priceUsd || 0);
                elizaLogger.error(`TokenAccountNotFoundError --- ${tokenAddress}:`, currentPrice);
                tradeRecord = {
                    token_address: tokenAddress,
                    recommender_id: runtime.agentId,
                    buy_price: currentPrice,
                    buy_amount: 0,
                    buy_timeStamp: new Date().toISOString(),
                    buy_market_cap: 0,
                    buy_liquidity: 0,
                    buy_value_usd: 0,
                    sell_price: currentPrice,
                    sell_timeStamp: new Date().toISOString(),
                    sell_amount: 0,
                };
            } else {
                throw error;
            }
        }
    }

    return tradeRecord;
}

/**
 * Check profit targets and stop loss, then prepare analysis parameters
 * @param tradeRecord The trade record to check
 * @param tokenAddress The token address
 * @param tokenData Processed token data
 * @param walletBalance Current wallet balance
 * @param trustScore Token trust score
 * @param runtime Runtime for state and other services
 * @param state Current state object
 * @param tokenProvider Token provider instance
 * @param trustScoreDb Database access
 * @param twitterService Twitter service for notifications
 * @param connection Solana connection
 * @returns Analysis parameters or null if sell was executed
 */
async function checkProfitTargetsAndPrepareAnalysis(
    tradeRecord: any,
    tokenAddress: string,
    tokenData: ProcessedTokenData,
    walletBalance: number,
    trustScore: number,
    runtime: IAgentRuntime,
    state: State,
    tokenProvider: TokenProvider,
    trustScoreDb: TrustScoreDatabase,
    twitterService: TwitterService,
    connection: Connection
) {
    if (!tradeRecord) {
        elizaLogger.warn(`No valid trade record for ${tokenAddress}, cannot check profit targets`);
        return {
            walletBalance,
            tokenAddress,
            price: Number(tokenData.dexScreenerData.pairs[0]?.priceUsd || 0),
            volume: tokenData.dexScreenerData.pairs[0]?.volume?.h24 || 0,
            marketCap: tokenData.dexScreenerData.pairs[0]?.marketCap || 0,
            liquidity: tokenData.dexScreenerData.pairs[0]?.liquidity?.usd || 0,
            holderDistribution: tokenData.holderDistributionTrend,
            trustScore: trustScore || 0,
            dexscreener: tokenData.dexScreenerData,
            position: undefined // No position since we have no valid trade record
        };
    }

    elizaLogger.log(`Checking profit targets for ${tokenAddress}:`, tradeRecord);

    const pair = tokenData.dexScreenerData.pairs[0];
    const currentPrice = Number(pair?.priceUsd || 0);
    const profitPercent = ((currentPrice - tradeRecord.buy_price) / tradeRecord.buy_price);

    elizaLogger.log(`Profit percent for ${tokenAddress}: ${profitPercent}`);

    // Check take profit target
    if (profitPercent >= SAFETY_LIMITS.TAKE_PROFIT) {
        elizaLogger.log(`Take profit target reached at ${(profitPercent * 100).toFixed(2)}% for ${tokenAddress}`);
        await sell({
            latestTrade: tradeRecord,
            result: {
                recommendation: "SELL",
                confidence: 90,
                reasoning: `Take profit target reached at ${(profitPercent * 100).toFixed(2)}%`
            },
            runtime,
            state,
            tokenAddress,
            tokenProvider,
            trustScoreDb,
            twitterService,
            trustScore,
            connection
        });
        return null; // Sell executed, no need for analysis params
    }

    // Check stop loss
    if (profitPercent <= -SAFETY_LIMITS.STOP_LOSS) {
        elizaLogger.log(`Stop loss triggered at ${(profitPercent * 100).toFixed(2)}% for ${tokenAddress}`);
        await sell({
            latestTrade: tradeRecord,
            result: {
                recommendation: "SELL",
                confidence: 95,
                reasoning: `Stop loss triggered at ${(profitPercent * 100).toFixed(2)}%`
            },
            runtime,
            state,
            tokenAddress,
            tokenProvider,
            trustScoreDb,
            twitterService,
            trustScore,
            connection
        });
        return null; // Sell executed, no need for analysis params
    }

    // No sell triggered, return analysis params
    return {
        walletBalance,
        tokenAddress,
        price: currentPrice,
        volume: pair?.volume?.h24 || 0,
        marketCap: pair?.marketCap || 0,
        liquidity: pair?.liquidity?.usd || 0,
        holderDistribution: tokenData.holderDistributionTrend,
        trustScore: trustScore || 0,
        dexscreener: tokenData.dexScreenerData,
        position: {
            token_address: tradeRecord.token_address,
            entry_price: tradeRecord.buy_price,
            size: tradeRecord.buy_amount,
            stop_loss: tradeRecord.buy_price * (1 - Math.abs(SAFETY_LIMITS.STOP_LOSS)),
            take_profit: tradeRecord.buy_price * (1 + SAFETY_LIMITS.TAKE_PROFIT),
            open_timeStamp: tradeRecord.buy_timeStamp,
            status: tradeRecord.sell_timeStamp ? "CLOSED" : "OPEN",
        }
    };
}

/**
 * Create an NFT for a trade and get the URL to view it
 * @param tradeData Data about the trade
 * @param runtime The agent runtime
 * @param walletProvider Wallet provider for minting
 * @returns The URL to view the created NFT, or empty string if creation failed
 */
async function createTradeNFT(
    tradeData: TradeBuyAlert,
    runtime: IAgentRuntime,
    walletProvider: ExtendedWalletProvider
  ): Promise<string> {
    try {
      elizaLogger.log(`Starting NFT creation for ${tradeData.action} of ${tradeData.token} (${tradeData.tokenAddress})`, {
        tradeData: { ...tradeData, timestamp: new Date(tradeData.timestamp).toISOString() }
      });

      // Configure NFT creation
      const nftConfig = { enabled: true, creationInterval: 10000 };
      elizaLogger.log("NFT configuration:", nftConfig);

      // Initialize NFT manager
      //const nftManager = new NFTManager(nftConfig, runtime, walletProvider);
      elizaLogger.log("NFT manager initialized successfully");

      // Create the NFT and get URL
      elizaLogger.log(`Generating trade NFT for ${tradeData.token}...`);
      const startTime = Date.now();

      //const nftUrl = await nftManager.createTradeNFTAndGetURL(tradeData, runtime);
      const nftUrl = await createTradeNFT(tradeData, runtime, walletProvider);
      if (nftUrl) {
        elizaLogger.log(`Successfully created NFT: ${nftUrl}`, {
          tokenSymbol: tradeData.token,
          action: tradeData.action,
          nftUrl
        });
        return nftUrl;
      } else {
        elizaLogger.warn(`NFT creation completed but returned empty URL!!!!!!!!!!!!!!!`);
        return "";
      }
    } catch (error) {
      elizaLogger.error(`Failed to create NFT for ${tradeData.token} ${tradeData.action} transaction:`, {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        tradeData
      });
      return "";
    }
  }

/**
 * Analyze token for bought and holding
 * @param runtime Runtime for state and other services
 * @param connection Solana connection
 * @param twitterService Twitter service for notifications
 * @param tokenAddress Token address to analyze
 */
async function analyzeTokenForBoughtAndHolding(
    runtime: IAgentRuntime,
    connection: Connection,
    twitterService: TwitterService,
    //telegramService: TelegramService,
    tokenAddress: string
) {
    try {
        let sellImmediately = false;
        // Create initial state first
        const state: State = await runtime.composeState({
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content: {
                text: `Initialize state for ${tokenAddress}`,
                type: "analysis",
            },
        });

        // Set variables used throughout the function
        const tokenProvider = new TokenProvider(tokenAddress);
        const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);
        const walletPublicKey = runtime.getSetting("WALLET_PUBLIC_KEY");
        const balance = await connection.getBalance(new PublicKey(walletPublicKey));
        const walletSolBalance = {formatted: (balance / 1e9).toString(),};
        elizaLogger.log(`walletSolBalance ------- ${tokenAddress}:`, {
            rawBalance: balance.toString(),
            formattedBalance: walletSolBalance.toString()
        });

        // Add random delay before fetching new data
        const delay = getRandomDelay2();
        elizaLogger.log(`Adding ${(delay/1000).toFixed(1)}s random delay before analyzing ${tokenAddress}`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Validate token address format
        const isValidAddress = validateSolanaAddress(tokenAddress);
        if (!isValidAddress) {
            elizaLogger.error(`Invalid token address format: ${tokenAddress}`);
            return;
        }

        // Then in the analyzeToken function, replace the original code with:
        const tokenData = await fetchAndValidateTokenData(tokenAddress, runtime, tokenProvider);
        if (!tokenData) {
            return; // Stop processing if validation failed
        }

        // Get trust score and cache it
        const trustScore = await evaluateTokenTrust(tokenAddress, runtime);
        if (trustScore === null) {
            return; // Stop processing if monitoring should be stopped
        }

        // If the evaluation signals that we should stop monitoring (e.g. token is trending down or rugged), update Airtable and exit
        if (trustScore == -99.99) {
            elizaLogger.warn("trustScore =========================== -99.99");
            sellImmediately = true;
            elizaLogger.warn(`Token ${tokenAddress} is trending downward or flagged as high risk. Stopping monitoring.`);
            await updateAirtableStatus(tokenAddress, "Stopped Monitoring", runtime, "PumpFunNewTokens");
        }

        //const latestTrade = trustScoreDb.getLatestTradePerformance(tokenAddress,runtime.agentId,false);
        const latestTrade = await withDatabaseRetry<TradePerformance | null>(() =>
            trustScoreDb.getLatestTradePerformance(tokenAddress, runtime.agentId, false)
        );
        const tradeRecord = await handleNullLatestTrade(
            latestTrade,
            tokenAddress,
            runtime,
            connection,
            tokenData,
            walletPublicKey
        );

        const walletBalance = balance / 1e9;
        //const pair = tokenData.dexScreenerData.pairs[0];
        //const currentPrice = Number(pair?.priceUsd || 0);
        //let profitPercent;
        const analysisParams = await checkProfitTargetsAndPrepareAnalysis(
            tradeRecord,
            tokenAddress,
            tokenData,
            walletBalance,
            trustScore,
            runtime,
            state,
            tokenProvider,
            trustScoreDb,
            twitterService,
            connection
        );

        if (!analysisParams) {
            return; // Exit function as sell was executed
        }

        // Then create analysis memory using state
        const analysisMemory: Memory = {
            userId: state.userId,
            agentId: runtime.agentId,
            roomId: state.roomId,
            content: {
                text: `Analyze trade for ${tokenAddress}`,
                type: "analysis",
            },
        };
        elizaLogger.log(`analyzeToken analysisParams ------- ${tokenAddress}:`, analysisParams);
        elizaLogger.log(`analyzeToken analysisMemory ------- ${tokenAddress}:`, analysisMemory);

        // If no Profit or stop loss is reached, we will analyze the token for a trade action
        await analyzeTradeAction.handler(
            runtime,
            analysisMemory,
            state,
            analysisParams,
            async (response) => {
                if (!response) {
                    elizaLogger.error(
                        `Empty response from analysis for ${tokenAddress}`
                    );
                    return [];
                }

                elizaLogger.log(
                    `Analysis result for ${tokenAddress}:`,
                    response
                );
                try {
                    // Parse the JSON response from the analysis
                    const result =
                        typeof response.text === "string"
                            ? JSON.parse(response.text)
                            : response.text;

                    if (!result) {
                        elizaLogger.error(
                            `Invalid analysis result for ${tokenAddress}`
                        );

                        return [];
                    }

                    if (
                        result.shouldTrade &&
                        result.recommendedAction === "BUY" ||
                        result.recommendation === "BUY"
                    ) {
                        elizaLogger.log(`BUY ${tokenAddress} immediately!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
                        // Check for existing position first
                        const positionCheck = await checkExistingPosition(tokenAddress, trustScoreDb);
                        if (positionCheck.shouldSkip) {
                            return;
                        }
                        elizaLogger.log(`positionCheck ------- ${tokenAddress}:`, positionCheck);

                        // Check for recent trades within reentry delay
                        const reentryCheck = await checkReentryDelay(tokenAddress, trustScoreDb);
                        if (reentryCheck.shouldSkip) {
                            return;
                        }
                        elizaLogger.log(`reentryCheck ------- ${tokenAddress}:`, reentryCheck);
                        //const currentOpenTrades = await trustScoreDb.getOpenTrades(tokenAddress);
                        const currentOpenTrades = await withDatabaseRetry<TradePosition[]>(() =>
                            trustScoreDb.getOpenTrades(tokenAddress)
                        );
                        if (currentOpenTrades.length > 0) {
                            elizaLogger.warn(`Position opened during analysis for ${tokenAddress}, skipping buy`);
                            return;
                        }
                        elizaLogger.log(`currentOpenTrades ------- ${tokenAddress}:`, currentOpenTrades);
                        const walletBalance = balance / 1e9;
                        elizaLogger.log(`walletBalance ------- ${tokenAddress}:`, {
                            rawBalance: balance.toString(),
                            formattedBalance: walletBalance.toString()
                        });
                        if (walletBalance < SAFETY_LIMITS.MINIMUM_TRADE) {
                            elizaLogger.warn(
                                `Insufficient SOL balance (${walletBalance.toFixed(4)} SOL) for buying. Minimum required: ${SAFETY_LIMITS.MINIMUM_TRADE} SOL`
                            );
                            return [];
                        }
                        await buy({
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenData,
                            twitterService,
                            //telegramService,
                            trustScore,
                        });
                    } else if (
                        sellImmediately ||
                        result.recommendedAction === "SELL" ||
                        result.recommendation === "SELL"
                    ) {
                        elizaLogger.log(`Selling ${tokenAddress} immediately!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
                        await sell({
                            latestTrade: tradeRecord,
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenProvider,
                            trustScoreDb,
                            twitterService,
                            trustScore,
                            connection
                        });
                    } else {
                        elizaLogger.log(
                            `Trade not recommended for ${tokenAddress}:`,
                            result
                        );
                    }
                } catch (parseError) {}
                return [];
            }
        );
    } catch (tokenError) {
        elizaLogger.error(`Error processing token ${tokenAddress}:`, {
            error: tokenError,
            stack: tokenError instanceof Error ? tokenError.stack : undefined,
        });
        if (tokenError.message?.includes('429')) {
            elizaLogger.warn(`Rate limit hit (429) for ${tokenAddress}, waiting 30s`);
            await new Promise(resolve => setTimeout(resolve, 30000));
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

/**
 * Analyze token
 * @param runtime Runtime for state and other services
 * @param connection Solana connection
 * @param twitterService Twitter service for notifications
 * @param tokenAddress Token address to analyze
 */
async function analyzeToken(
    runtime: IAgentRuntime,
    connection: Connection,
    twitterService: TwitterService,
    //telegramService: TelegramService,
    tokenAddress: string
) {
    try {
        let sellImmediately = false;
        // Create initial state first
        const state: State = await runtime.composeState({
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            content: {
                text: `Initialize state for ${tokenAddress}`,
                type: "analysis",
            },
        });

        // Set variables used throughout the function
        const tokenProvider = new TokenProvider(tokenAddress);
        const trustScoreDb = new TrustScoreDatabase(runtime.databaseAdapter.db);
        const walletPublicKey = runtime.getSetting("WALLET_PUBLIC_KEY");
        const balance = await connection.getBalance(new PublicKey(walletPublicKey));
        const walletSolBalance = {formatted: (balance / 1e9).toString(),};
        elizaLogger.log(`walletSolBalance ------- ${tokenAddress}:`, {
            rawBalance: balance.toString(),
            formattedBalance: walletSolBalance.toString()
        });

        // Add random delay before fetching new data
        const delay = getRandomDelay2();
        elizaLogger.log(`Adding ${(delay/1000).toFixed(1)}s random delay before analyzing ${tokenAddress}`);
        await new Promise(resolve => setTimeout(resolve, delay));

        // Validate token address format
        const isValidAddress = validateSolanaAddress(tokenAddress);
        if (!isValidAddress) {
            elizaLogger.error(`Invalid token address format: ${tokenAddress}`);
            return;
        }

        // Then in the analyzeToken function, replace the original code with:
        const tokenData = await fetchAndValidateTokenData(tokenAddress, runtime, tokenProvider);
        if (!tokenData) {
            return; // Stop processing if validation failed
        }

        // Get trust score and cache it
        const trustScore = await evaluateTokenTrust(tokenAddress, runtime);
        if (trustScore === null) {
            return; // Stop processing if monitoring should be stopped
        }

        // If the evaluation signals that we should stop monitoring (e.g. token is trending down or rugged), update Airtable and exit
        if (trustScore == -99.99) {
            elizaLogger.warn("trustScore =========================== -99.99");
            sellImmediately = true;
            elizaLogger.warn(`Token ${tokenAddress} is trending downward or flagged as high risk. Stopping monitoring.`);
            await updateAirtableStatus(tokenAddress, "Stopped Monitoring", runtime, "PumpFunNewTokens");
        }

        //const latestTrade = trustScoreDb.getLatestTradePerformance(tokenAddress,runtime.agentId,false);
        const latestTrade = await withDatabaseRetry<TradePerformance>(() =>
            trustScoreDb.getLatestTradePerformance(tokenAddress, runtime.agentId, false)
        );
        const tradeRecord = await handleNullLatestTrade(
            latestTrade,
            tokenAddress,
            runtime,
            connection,
            tokenData,
            walletPublicKey
        );

        const walletBalance = balance / 1e9;
        //const pair = tokenData.dexScreenerData.pairs[0];
        //const currentPrice = Number(pair?.priceUsd || 0);
        //let profitPercent;
        const analysisParams = await checkProfitTargetsAndPrepareAnalysis(
            tradeRecord,
            tokenAddress,
            tokenData,
            walletBalance,
            trustScore,
            runtime,
            state,
            tokenProvider,
            trustScoreDb,
            twitterService,
            connection
        );

        if (!analysisParams) {
            return; // Exit function as sell was executed
        }

        // Then create analysis memory using state
        const analysisMemory: Memory = {
            userId: state.userId,
            agentId: runtime.agentId,
            roomId: state.roomId,
            content: {
                text: `Analyze trade for ${tokenAddress}`,
                type: "analysis",
            },
        };
        elizaLogger.log(`analyzeToken analysisParams ------- ${tokenAddress}:`, analysisParams);
        elizaLogger.log(`analyzeToken analysisMemory ------- ${tokenAddress}:`, analysisMemory);

        // If no Profit or stop loss is reached, we will analyze the token for a trade action
        await analyzeTradeAction.handler(
            runtime,
            analysisMemory,
            state,
            analysisParams,
            async (response) => {
                if (!response) {
                    elizaLogger.error(
                        `Empty response from analysis for ${tokenAddress}`
                    );
                    return [];
                }

                elizaLogger.log(
                    `Analysis result for ${tokenAddress}:`,
                    response
                );
                try {
                    // Parse the JSON response from the analysis
                    const result =
                        typeof response.text === "string"
                            ? JSON.parse(response.text)
                            : response.text;

                    if (!result) {
                        elizaLogger.error(
                            `Invalid analysis result for ${tokenAddress}`
                        );

                        return [];
                    }

                    if (
                        result.shouldTrade &&
                        result.recommendedAction === "BUY" ||
                        result.recommendation === "BUY"
                    ) {
                        elizaLogger.log(`BUY ${tokenAddress} immediately!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
                        // Check for existing position first
                        const positionCheck = await checkExistingPosition(tokenAddress, trustScoreDb);
                        if (positionCheck.shouldSkip) {
                            return;
                        }
                        elizaLogger.log(`positionCheck ------- ${tokenAddress}:`, positionCheck);

                        // Check for recent trades within reentry delay
                        const reentryCheck = await checkReentryDelay(tokenAddress, trustScoreDb);
                        if (reentryCheck.shouldSkip) {
                            return;
                        }
                        elizaLogger.log(`reentryCheck ------- ${tokenAddress}:`, reentryCheck);
                        //const currentOpenTrades = await trustScoreDb.getOpenTrades(tokenAddress);
                        const currentOpenTrades = await withDatabaseRetry<TradePosition[]>(() =>
                            trustScoreDb.getOpenTrades(tokenAddress)
                        );
                        if (currentOpenTrades.length > 0) {
                            elizaLogger.warn(`Position opened during analysis for ${tokenAddress}, skipping buy`);
                            return;
                        }
                        elizaLogger.log(`currentOpenTrades ------- ${tokenAddress}:`, currentOpenTrades);
                        const walletBalance = balance / 1e9;
                        elizaLogger.log(`walletBalance ------- ${tokenAddress}:`, {
                            rawBalance: balance.toString(),
                            formattedBalance: walletBalance.toString()
                        });
                        if (walletBalance < SAFETY_LIMITS.MINIMUM_TRADE) {
                            elizaLogger.warn(
                                `Insufficient SOL balance (${walletBalance.toFixed(4)} SOL) for buying. Minimum required: ${SAFETY_LIMITS.MINIMUM_TRADE} SOL`
                            );
                            return [];
                        }
                        await buy({
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenData,
                            twitterService,
                            //telegramService,
                            trustScore,
                        });
                    } else if (
                        sellImmediately ||
                        result.recommendedAction === "SELL" ||
                        result.recommendation === "SELL"
                    ) {
                        elizaLogger.log(`Selling ${tokenAddress} immediately!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
                        await sell({
                            latestTrade: tradeRecord,
                            result,
                            runtime,
                            state,
                            tokenAddress,
                            tokenProvider,
                            trustScoreDb,
                            twitterService,
                            trustScore,
                            connection
                        });
                    } else {
                        elizaLogger.log(
                            `Trade not recommended for ${tokenAddress}:`,
                            result
                        );
                    }
                } catch (parseError) {}
                return [];
            }
        );
    } catch (tokenError) {
        elizaLogger.error(`Error processing token ${tokenAddress}:`, {
            error: tokenError,
            stack: tokenError instanceof Error ? tokenError.stack : undefined,
        });
        if (tokenError.message?.includes('429')) {
            elizaLogger.warn(`Rate limit hit (429) for ${tokenAddress}, waiting 30s`);
            await new Promise(resolve => setTimeout(resolve, 30000));
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
}

/**
 * Buy a token
 * @param runtime Runtime for state and other services
 * @param tokenAddress Token address to buy
 * @param state State for the agent
 * @param tokenData Processed token data
 * @param result Result from the analysis
 */
async function buy({
    runtime,
    tokenAddress,
    state,
    tokenData,
    result,
    twitterService,
    //telegramService,
    trustScore,
}: {
    runtime: IAgentRuntime;
    tokenAddress: string;
    state: State;
    tokenData: ProcessedTokenData;
    result: any;
    twitterService: TwitterService;
    //telegramService: TelegramService;
    trustScore: number;
}) {
    elizaLogger.log(`Buy recommended for ${tokenAddress}:`, result);

    // Continue with simulation if analysis recommends trading
    const simulationService = new SimulationService();
    const simulation = await simulationService.simulateSolanaMemeCoinTrade(
        tokenAddress,
        result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE
    );
    elizaLogger.log(`Buy simulation result for ${tokenAddress}:`, simulation);

    if (simulation.recommendedAction === "EXECUTE") {
        try {
            const currentBalance = await getWalletBalance(runtime);
            const tradeAmount = Math.min(
                result.suggestedAmount || SAFETY_LIMITS.MINIMUM_TRADE,
                currentBalance * 0.90 // Leave some SOL for fees
            );

            if (tradeAmount < SAFETY_LIMITS.MINIMUM_TRADE) {
                elizaLogger.warn(
                    `Insufficient balance for trade: ${currentBalance} SOL`
                );
            }

            // Execute trade using our custom function
            const tradeResult = await executeTrade(runtime, {
                tokenAddress,
                amount: tradeAmount,
                slippage: tokenAddress.startsWith("0x") ? 0.03 : SAFETY_LIMITS.MAX_SLIPPAGE, // 3% for Base, 20% for Solana
                isSell: false,
                chain: "solana",
            });

            if (tradeResult.success) {
                elizaLogger.log(
                    `Trade executed successfully for ${tokenAddress}:`,
                    {
                        signature: tradeResult.signature,
                        amount: tradeAmount,
                        memory: {
                            userId: state.userId,
                            agentId: runtime.agentId,
                            roomId: state.roomId,
                            content: {
                                text: `Execute trade for ${tokenAddress}`,
                                tokenAddress,
                                amount: SAFETY_LIMITS.MINIMUM_TRADE,
                                action: result.recommendedAction,
                                source: "system",
                                type: "trade",
                            },
                        },
                    }
                );

                // Update Airtable status
                await updateAirtableStatus(tokenAddress, "Bought and Holding", runtime, "PumpFunNewTokens");

                if(shouldTweetTradeForSolanaMemeCoins){
                    try {
                        // Tweet about the trade data
                        const currentTokenSymbol = tokenData.dexScreenerData?.pairs?.[0]?.baseToken?.symbol || tokenAddress;
                        await tweetTrade(twitterService, {
                            token: currentTokenSymbol,
                            tokenAddress: tokenAddress,
                            amount: tradeAmount,
                            trustScore: Number(trustScore) || 0,
                            riskLevel: result.riskLevel || "MEDIUM",
                            marketData: {
                                priceChange5m: tokenData.dexScreenerData?.pairs?.[0]?.priceChange?.m5 || 0,
                                volume5m: tokenData.dexScreenerData?.pairs?.[0]?.volume?.m5 || 0,
                                priceChange24h: tokenData.dexScreenerData?.pairs?.[0]?.priceChange?.h24 || 0,
                                volume24h: tokenData.dexScreenerData?.pairs?.[0]?.volume?.h24 || 0,
                                liquidity: {
                                    usd: tokenData.dexScreenerData?.pairs?.[0]?.liquidity?.usd || 0,
                                },
                            },
                            timestamp: Date.now(),
                            signature: tradeResult.signature || "",
                            hash: tradeResult.hash || "",
                            action: "BUY",
                            price: Number(tokenData.dexScreenerData?.pairs?.[0]?.priceUsd || 0),
                        });

                        // Create NFT about trade data and then tweet about the nft
                        elizaLogger.log("before createTradeNFT:::::::::::::::::::");
                        const nftUrl = await createTradeNFT({
                            token: currentTokenSymbol,
                            tokenAddress: tokenAddress,
                            action: "BUY",
                            price: Number(tokenData.dexScreenerData?.pairs?.[0]?.priceUsd || 0),
                            timestamp: Date.now(),
                            hash: tradeResult.signature,
                            amount: tradeAmount,
                            trustScore: Number(trustScore) || 0,
                            riskLevel: result.riskLevel || "MEDIUM",
                            marketData: {
                              priceChange24h: 0,
                              volume24h: 0,
                              priceChange5m: 0,
                              volume5m: 0,
                              liquidity: { usd: 0 }
                            }
                          }, runtime, walletProvider);

                          elizaLogger.log("after createTradeNFT:::::::::::::::::::", nftUrl);
                          if (nftUrl) {
                            await twitterService.postTradeAlertWithNft(result, nftUrl, tokenAddress);
                          }
                    } catch (tweetError) {
                        elizaLogger.error(`Failed to tweet about trade for ${tokenAddress}:`, {
                            error: tweetError,
                            message: tweetError instanceof Error ? tweetError.message : String(tweetError),
                        });
                        // Continue execution even if tweet fails
                    }
                }

                if(shouldCreateNftForSolanaMemeCoins){
                    try {
                        // Tweet about the trade data
                        const currentTokenSymbol = tokenData.dexScreenerData?.pairs?.[0]?.baseToken?.symbol || tokenAddress;

                        // Create NFT about trade data and then tweet about the nft
                        elizaLogger.log("before createTradeNFT:::::::::::::::::::");
                        const nftUrl = await createTradeNFT({
                            token: currentTokenSymbol,
                            tokenAddress: tokenAddress,
                            action: "BUY",
                            price: Number(tokenData.dexScreenerData?.pairs?.[0]?.priceUsd || 0),
                            timestamp: Date.now(),
                            hash: tradeResult.signature,
                            amount: tradeAmount,
                            trustScore: Number(trustScore) || 0,
                            riskLevel: result.riskLevel || "MEDIUM",
                            marketData: {
                              priceChange24h: 0,
                              volume24h: 0,
                              priceChange5m: 0,
                              volume5m: 0,
                              liquidity: { usd: 0 }
                            }
                          }, runtime, walletProvider);

                          elizaLogger.log("after createTradeNFT:::::::::::::::::::", nftUrl);
                          if (nftUrl) {
                            await twitterService.postTradeAlertWithNft(result, nftUrl, tokenAddress);
                          }
                    } catch (tweetError) {
                        elizaLogger.error(`Failed to tweet about trade for ${tokenAddress}:`, {
                            error: tweetError,
                            message: tweetError instanceof Error ? tweetError.message : String(tweetError),
                        });
                        // Continue execution even if tweet fails
                    }
                }

                //await sendTelegramMessage(telegramService, {
                //    token:
                //        tokenData.dexScreenerData.pairs[0]?.baseToken
                //            ?.symbol || tokenAddress,
                //    tokenAddress: tokenAddress,
                //    amount: tradeAmount,
                //    trustScore: Number(trustScore) || 0,
                //    riskLevel: result.riskLevel || "MEDIUM",
                //    marketData: {
                //        priceChange5m: tokenData.dexScreenerData.pairs[0]?.priceChange ?.m5 || 0,
                //        volume5m: tokenData.dexScreenerData.pairs[0]?.volume ?.m5 || 0,
                //       priceChange24h: tokenData.dexScreenerData.pairs[0]?.priceChange ?.h24 || 0,
                //        volume24h: tokenData.dexScreenerData.pairs[0]?.volume ?.h24 || 0,
                //        liquidity: {
                //            usd: tokenData.dexScreenerData.pairs[0] ?.liquidity?.usd || 0,
                //        },
                //    },
                //    timestamp: Date.now(),
                //    signature: tradeResult.signature,
                //    hash: tradeResult.hash,
                //    action: "BUY",
                //    price: Number(
                //        tokenData.dexScreenerData.pairs[0]?.priceUsd || 0
                //    ),
                //});

                try {
                    // Record trade using TrustScoreDatabase methods
                    const trustScoreDb = new TrustScoreDatabase(
                        runtime.databaseAdapter.db
                    );

                    // Remove the PublicKey validation for Base addresses
                    elizaLogger.log(
                        `Attempting to validate token address: ${tokenAddress}`
                    );
                    const formattedAddress = tokenAddress.startsWith("0x")
                        ? tokenAddress
                        : new PublicKey(tokenAddress).toBase58(); // Only convert Solana addresses
                    elizaLogger.log(
                        `Token address validated successfully: ${formattedAddress}`
                    );
                    // Create a new recommender ID for this trade
                    const uuid = uuidv4();
                    const recommender =
                        await trustScoreDb.getOrCreateRecommender({
                            id: uuid,
                            address: "",
                            solanaPubkey:
                                runtime.getSetting("WALLET_PUBLIC_KEY") || "",
                        });
                    elizaLogger.log(`Created/retrieved recommender:`, {
                        recommender,
                        chainType: tokenAddress.startsWith("0x")
                            ? "base"
                            : "solana",
                    });

                    // Prepare trade data
                    const tradeData = {
                        buy_amount: tradeAmount,
                        is_simulation: false,
                        token_address: new PublicKey(tokenAddress).toBase58(),
                        buy_price:
                            tokenData.dexScreenerData.pairs[0]?.priceUsd || 0,
                        buy_timeStamp: new Date().toISOString(),
                        buy_market_cap:
                            tokenData.dexScreenerData.pairs[0]?.marketCap || 0,
                        buy_liquidity:
                            tokenData.dexScreenerData.pairs[0]?.liquidity
                                ?.usd || 0,
                        buy_value_usd:
                            tradeAmount *
                            Number(
                                tokenData.dexScreenerData.pairs[0]?.priceUsd ||
                                    0
                            ),
                    };
                    elizaLogger.log(`Prepared trade data:`, tradeData);

                    // Create trade record directly using trustScoreDb
                    await trustScoreDb.addTradePerformance(
                        {
                            token_address: formattedAddress, // Use the properly formatted address
                            recommender_id: recommender.id,
                            buy_price: Number(tradeData.buy_price),
                            buy_timeStamp: tradeData.buy_timeStamp,
                            buy_amount: tradeData.buy_amount,
                            buy_value_usd: tradeData.buy_value_usd,
                            buy_market_cap: tradeData.buy_market_cap,
                            buy_liquidity: tradeData.buy_liquidity,
                            buy_sol: tradeAmount,
                            last_updated: new Date().toISOString(),
                            sell_price: 0,
                            sell_timeStamp: "",
                            sell_amount: 0,
                            received_sol: 0,
                            sell_value_usd: 0,
                            sell_market_cap: 0,
                            sell_liquidity: 0,
                            profit_usd: 0,
                            profit_percent: 0,
                            market_cap_change: 0,
                            liquidity_change: 0,
                            rapidDump: false,
                        },
                        false
                    );

                    elizaLogger.log(
                        `Successfully recorded trade performance for ${tokenAddress}`
                    );

                    // Generate image for trade data
                    let status = await generateImageForSolanaSwapAction(runtime, {
                        token: tokenData.dexScreenerData?.pairs?.[0]?.baseToken?.symbol || tokenAddress,
                        amount: tradeAmount,
                        trustScore: Number(trustScore) || 0,
                        riskLevel: result.riskLevel || "MEDIUM",
                        marketData: {
                            priceChange24h: tokenData.dexScreenerData?.pairs?.[0]?.priceChange?.h24 || 0,
                            volume24h: tokenData.dexScreenerData?.pairs?.[0]?.volume?.h24 || 0,
                            liquidity: {
                                usd: tokenData.dexScreenerData?.pairs?.[0]?.liquidity?.usd || 0,
                            },
                        },
                        timestamp: Date.now(),
                        signature: tradeResult.signature || "",
                        action: "BUY",
                        price: Number(tokenData.dexScreenerData?.pairs?.[0]?.priceUsd || 0),
                    }, twitterService);
                    elizaLogger.log("after generateImageForSolanaSwapAction:::::::::::::::::::", status);
                } catch (error) {
                    elizaLogger.error("Failed to record trade performance:", {
                        error,
                        tokenAddress,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        stack: error instanceof Error ? error.stack : undefined,
                        errorType: error?.constructor?.name,
                    });
                }
            }
            else {
                elizaLogger.error(
                    `Trade execution failed for ${tokenAddress}:`,
                    tradeResult.error
                );
            }
        } catch (tradeError) {
            elizaLogger.error(
                `Error during trade execution for ${tokenAddress}:`,
                {
                    error: tradeError,
                    stack:
                        tradeError instanceof Error
                            ? tradeError.stack
                            : undefined,
                }
            );
        } finally {
            // Always release the lock
            //tradeLocks.delete(tokenAddress);
        }
    } else {
        elizaLogger.log(
            `Simulation rejected trade for ${tokenAddress}:`,
            simulation
        );
    }
}

/**
 * Sell a token
 * @param state State for the agent
 * @param runtime Runtime for state and other services
 * @param tokenAddress Token address to sell
 * @param tokenProvider Token provider for the token
 * @param twitterService Twitter service for notifications
 */
async function sell({
    state,
    runtime,
    tokenAddress,
    tokenProvider,
    twitterService,
    trustScoreDb,
    latestTrade,
    result,
    trustScore,
    connection
}: {
    state: State;
    runtime: IAgentRuntime;
    tokenAddress: string;
    tokenProvider: TokenProvider;
    twitterService: TwitterService;
    trustScoreDb: TrustScoreDatabase;
    result: any;
    latestTrade: TradePerformance;
    trustScore: number;
    connection: Connection;
}) {
    // Exit if no trade record or zero balance
    if (!latestTrade?.buy_amount) {
        elizaLogger.log(`No position to sell for ${tokenAddress}`);
        return;
    }

    // Add dust amount check
    if (Number(latestTrade?.buy_amount || 0) < SAFETY_LIMITS.DUST_TOKEN_AMOUNT) {
        elizaLogger.warn(`Dust amount detected (${Number(latestTrade?.buy_amount || 0)}), skipping sell for ${tokenAddress}`);
        return;
    }

    // Get the trade amount from the latest trade
    const tradeAmount = Number(latestTrade?.buy_amount || 0);
    // Before executing trade, add logging
    elizaLogger.log(`Executing sell with params:`, {
        tokenAddress,
        amount: tradeAmount,
        isSell: true  // Make sure this is being passed
    });

    const tradeResult = await executeTrade(runtime, {
        tokenAddress,
        amount: tradeAmount,
        slippage: SAFETY_LIMITS.MAX_SLIPPAGE,
        chain: "solana",
        isSell: true
    });

    // Check wallet balance after trade attempt regardless of success
    //const postTradeBalance = await getTokenBalance(
    //    connection,
    //    new PublicKey(runtime.getSetting("WALLET_PUBLIC_KEY") || ""),
    //    new PublicKey(tokenAddress)
    //);
    // If we have no balance after trade attempt, consider it successful
    if (tradeResult.success) {
        await updateAirtableStatus(tokenAddress, "Bought and Sold", runtime, "PumpFunNewTokens");

        elizaLogger.log(`Sell executed successfully for ${tokenAddress}:`, {
            signature: tradeResult.signature,
            amount: tradeAmount,
            memory: {
                userId: state.userId,
                agentId: runtime.agentId,
                roomId: state.roomId,
                content: {
                    text: `Execute sell for ${tokenAddress}`,
                    tokenAddress,
                    amount: tradeAmount,
                    action: "SELL",
                    source: "system",
                    type: "trade",
                },
            }
        });

        // Record trade in database
        //await recordTradeInDatabase(tokenAddress, tokenData, postTradeBalance, runtime);

        // Post tweet if enabled
        const shouldTweetSell = true;
        if (twitterService && canTweet('trade') && shouldTweetSell) {
            // Use the new tweetSell function instead of tweetTrade
            await tweetSell(
                twitterService,
                latestTrade?.token_address || tokenAddress,
                Number(latestTrade?.sell_price || 0),
                `${latestTrade?.profit_percent?.toFixed(2) || '0.00'}%`,
                `${latestTrade?.profit_usd?.toFixed(4) || '0.0000'} USD`,
                `P/L: ${latestTrade?.profit_percent?.toFixed(2) || '0.00'}%`,
                tradeResult.hash
            );

            elizaLogger.log(`Successfully tweeted sell for ${tokenAddress} with profit: ${latestTrade?.profit_percent?.toFixed(2) || '0.00'}%`);
        }

        const tokenData = await tokenProvider.getProcessedTokenData();
        // Update sell details and get prices
        const { sellDetails, currentPrice } = await updateSellDetails(
            runtime,
            tokenAddress,
            latestTrade.recommender_id,
            tradeAmount,
            latestTrade,
            tokenData
        );
        elizaLogger.info("sellDetails", sellDetails);
        elizaLogger.info("currentPrice", currentPrice);
    }
    else {
        elizaLogger.error(
            `Sell execution failed for ${tokenAddress}:`,
            tradeResult.error
        );
    }

}

/**
 * Send a branding image via Telegram
 * @param imagePath The path to the image file
 * @param telegramService The Telegram service
 * @returns True if the image was sent successfully, false otherwise
 */
const sendTelegramMessageWithBrandingImage = async (
    imagePath: string,
    telegramService?: TelegramService,
    runtime?: IAgentRuntime,
    imageUrl?: string
): Promise<boolean> => {
    try {
        if (!telegramService) {
            elizaLogger.error("Cannot send Telegram branding image: Telegram service is not available");
            return false;
        }

        if (!imagePath || !fs.existsSync(imagePath)) {
            elizaLogger.error("Cannot send Telegram branding image: Image not found at path", imagePath);
            return false;
        }

        // Use imageUrl if provided, or just the local path
        const imageLocation = imageUrl || imagePath;

        const telegramMessages = [
            "🤖 Tiny Coin Trader is scanning the markets 24/7 for the best opportunities! #AI #TradingBot #Crypto",
            "📈 Let AI handle your trades while you focus on what matters. Tiny Coin Trader never sleeps!",
            "💰 Smart trading decisions powered by advanced algorithms. Tiny Coin Trader at your service!",
            "⚡ Lightning-fast execution, data-driven decisions. This is how we trade.",
            "🧠 When human emotions fail, algorithms prevail. Trading with precision 24/7.",
            "🚀 Navigating the crypto markets with algorithmic precision.",
            "📊 Making data-backed trading decisions for optimal returns.",
            "💼 Your automated trading companion in the volatile crypto market.",
            "🔍 Constantly analyzing market patterns to find the next opportunity.",
            "⏱️ Trading never stops, and neither does Tiny Coin Trader."
        ];

        // Select a random message
        const message = telegramMessages[Math.floor(Math.random() * telegramMessages.length)];
        elizaLogger.logColorful("Sending Telegram branding image with message:", message);

        // Create a formatted message that includes the image URL if available
        const formattedMessage = `${message}\n\n${imageUrl ? `🖼️ Image: ${imageUrl}` : ''}`;

        // Try/catch around the actual send to get specific error details
        try {
            await telegramService.sendMessage(formattedMessage);
            elizaLogger.log("Successfully sent branding message via Telegram");
            return true;
        } catch (sendError) {
            elizaLogger.error("Error in telegramService.sendMessage():", {
                error: sendError instanceof Error ? sendError.message : String(sendError),
                stack: sendError instanceof Error ? sendError.stack : undefined
            });

            // Try another approach (for debugging purposes)
            elizaLogger.log("Telegram service may need to be updated or initialized properly");
            return false;
        }
    } catch (error) {
        elizaLogger.error("Error in sendTelegramMessageWithBrandingImage:", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        });
        return false;
    }
};

/**
 * Send a branding image via Discord
 * @param imagePath The path to the image file
 * @param runtime The runtime environment
 * @returns True if the image was sent successfully, false otherwise
 */
const sendDiscordMessage = async (
    imagePath: string,
    discordChannelId: string,
    runtime?: IAgentRuntime
): Promise<boolean> => {
    try {
        if (!runtime) {
            elizaLogger.error("Cannot send Discord branding image: Runtime is not provided");
            return false;
        }

        // Check if the image exists
        if (!imagePath || !fs.existsSync(imagePath)) {
            elizaLogger.error("Cannot send Discord branding image: Image not found at path", imagePath);
            return false;
        }

        const discordMessages = [
            "🤖 Tiny Coin Trader is scanning the markets 24/7 for the best opportunities! #AI #TradingBot #Crypto",
            "📈 Let AI handle your trades while you focus on what matters. Tiny Coin Trader never sleeps!",
            "💰 Smart trading decisions powered by advanced algorithms. Tiny Coin Trader at your service!",
            "⚡ Lightning-fast execution, data-driven decisions. This is how we trade.",
            "🧠 When human emotions fail, algorithms prevail. Trading with precision 24/7.",
            "🚀 Navigating the crypto markets with algorithmic precision.",
            "📊 Making data-backed trading decisions for optimal returns.",
            "💼 Your automated trading companion in the volatile crypto market.",
            "🔍 Constantly analyzing market patterns to find the next opportunity.",
            "⏱️ Trading never stops, and neither does Tiny Coin Trader."
        ];

        // Select a random message
        const message = discordMessages[Math.floor(Math.random() * discordMessages.length)];
        elizaLogger.logColorfulForDiscord("Sending Discord branding image with message:", message);

        // Upload to ImgBB to get a direct image URL
        const imageUrl = await uploadImageToImgBB(imagePath, runtime);
        if (!imageUrl) {
            elizaLogger.error("Failed to upload image to ImgBB for Discord message");
            return false;
        }

        // Send the message using our service function with proper parameter order
        elizaLogger.logColorfulForDiscord(`Sending Discord message to channel: ${discordChannelId}`);
        const success = await sendDiscordMessageToChannel(message, imageUrl, discordChannelId, runtime);
        elizaLogger.logColorfulForDiscord(`Discord message sent to channel: ${discordChannelId}`);

        if (success) {
            elizaLogger.logColorfulForDiscord("Successfully sent branding image to Discord");
            return true;
        } else {
            elizaLogger.error("Failed to send branding image to Discord");
            return false;
        }
    } catch (error) {
        elizaLogger.error("Error sending branding image to Discord:", error);
        return false;
    }
};

export default createTinyCoinTraderPlugin;
