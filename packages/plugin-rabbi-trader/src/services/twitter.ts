import { z } from "zod";
import { elizaLogger } from "@elizaos/core";
import { MAX_TWEETS_PER_HOUR } from "../constants";
import { MarketData } from "../types";
import { imageGeneration  } from "@elizaos/plugin-image-generation";
import fs from "fs";

export const TwitterConfigSchema = z.object({
  enabled: z.boolean(),
  username: z.string().min(1),
  dryRun: z.boolean().optional().default(false),
  apiKey: z.string().optional(),
});

export interface TradeAlert {
  token: string;
  amount: number;
  trustScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  marketData: {
    priceChange24h: number;
    volume24h: number;
    liquidity: {
      usd: number;
    };
  };
  timestamp: number;
  signature?: string;
  action?: "BUY" | "SELL" | "WAIT" | "SKIP";
  reason?: string;
  price?: number;
  profitPercent?: string;
  profitUsd?: string;
}

export interface TradeBuyAlert {
  token: string;
  tokenAddress: string;
  amount: number;
  trustScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  marketData: MarketData;
  timestamp: number;
  signature?: string;
  hash?: string;
  explorerUrl?: string;
  action?: "BUY" | "SELL" | "WAIT" | "SKIP";
  reason?: string;
  price?: number;
  profitPercent?: string;
  profitUsd?: string;
}

export interface NFTAlert {
    name: string;
    action: string;
    price: number;
    profit?: number;
    mintAddress?: string;
  }

/**
 * Tweet about a trade transaction with available data from trade transaction
 * @param twitterService The Twitter service instance
 * @param alert The trade alert object
 * @param tokenAddress The token address of the trade
 */
export const tweetTrade = async (
  twitterService: TwitterService,
  alert: TradeBuyAlert| FreqTradeAlert,
  tokenAddress?: string
) => {
    if (tokenAddress === "FreqTrade" || (alert as any).strategy) {
        // This is a FreqTrade alert
        await twitterService.postFreqTradeAlert({
          strategy: (alert as any).strategy || "",
          timeframe: (alert as any).timeframe || "Auto",
          pair: (alert as any).pair || "Multiple",
          profit: (alert as any).profit || 0,
          tradeCount: (alert as any).tradeCount || 0,
          winRate: (alert as any).winRate || 0,
          bestPair: (alert as any).bestPair,
          worstPair: (alert as any).worstPair,
          timestamp: Date.now(),
        });
      } else {
        // Regular trade alert
        await twitterService.postTradeAlert(
          {
            ...alert as TradeBuyAlert,
            timestamp: Date.now(),
          },
          tokenAddress
        );
      }
};

/**
 * Tweet about a sell transaction with available data from sell transaction
 * @param twitterService The Twitter service instance
 * @param tokenSymbol Symbol of the token sold
 * @param sellPrice Price at which token was sold
 * @param profitPercent Percentage profit/loss from the trade
 * @param profitUsd USD amount of profit/loss
 * @param reason Reason for selling
 * @param transactionHash Optional transaction hash for blockchain reference
 */
export const tweetSell = async (
    twitterService: TwitterService,
    tokenSymbol: string,
    sellPrice: number,
    profitPercent: string,
    profitUsd: string,
    reason: string,
    transactionHash?: string
  ) => {
    try {
      // Skip tweeting if there's no profit (0.00% or negative)
      const numericProfit = parseFloat(profitPercent.replace('%', ''));
      if (numericProfit <= 0) {
        elizaLogger.log(`Skipping tweet for ${tokenSymbol} with 0 or negative profit (${profitPercent})`);
        return true;
      }

      // Create a simplified alert object with just the sell-related fields
      const sellAlert: TradeBuyAlert = {
        token: tokenSymbol,
        tokenAddress: "", // Not needed for sell tweets
        amount: 0, // Not critical for sell tweets
        trustScore: 0, // Not used in sell tweets
        riskLevel: "MEDIUM", // Default value, not critical for sell
        marketData: {
          // Minimal market data to satisfy the interface
          priceChange24h: 0,
          volume24h: 0,
          priceChange5m: 0,
          volume5m: 0,
          liquidity: { usd: 0 }
        },
        timestamp: Date.now(),
        action: "SELL",
        price: sellPrice,
        profitPercent,
        profitUsd,
        reason
      };

      // If transaction hash available, add it
      if (transactionHash) {
        sellAlert.hash = transactionHash;
      }

      // Post the tweet
      await twitterService.postTradeAlert(sellAlert, "");

      return true;
    } catch (error) {
      elizaLogger.error("Failed to tweet sell transaction:", error);
      return false;
    }
  };

// Add token tracking map
const tokenTweetTimes = new Map<string, number>();
export function canTweet(
    tweetType: "trade" | "market_search" | "shabbat" | "holiday" | "freqtrade" | "nft" | "branding",
    tokenAddress?: string
): boolean {
    // Add freqtrade to MAX_TWEETS_PER_HOUR if not already there
    if (!MAX_TWEETS_PER_HOUR["freqtrade"]) {
        MAX_TWEETS_PER_HOUR["freqtrade"] = 5;
    }
    if (!MAX_TWEETS_PER_HOUR["nft"]) {
      MAX_TWEETS_PER_HOUR["nft"] = 5;
    }

    // Rest of existing function...
    const now = Date.now();
    const hourKey = `tweets_${tweetType}_${Math.floor(now / 3600000)}`;

    // Simple in-memory rate limiting
    const tweetCounts = new Map<string, number>();
    const currentCount = tweetCounts.get(hourKey) || 0;

    // Check global rate limit
    if (currentCount >= MAX_TWEETS_PER_HOUR[tweetType]) {
        elizaLogger.warn(`Tweet rate limit reached for ${tweetType}`);
        return false;
    }

    // Check token-specific cooldown if this is a trade tweet
    if (tweetType === "trade" && tokenAddress) {
        const lastTweetTime = tokenTweetTimes.get(tokenAddress) || 0;
        const timeSinceLastTweet = now - lastTweetTime;

        if (timeSinceLastTweet < 60 * 60 * 1000) { // 60 minutes in milliseconds
            elizaLogger.warn(`Tweet cooldown active for token ${tokenAddress}`);
            return false;
        }

        // Update last tweet time for this token
        tokenTweetTimes.set(tokenAddress, now);
    }

    tweetCounts.set(hourKey, currentCount + 1);
    return true;
}

export class TwitterService {
  private client: any;
  private config: z.infer<typeof TwitterConfigSchema>;

  // Add public getter for config
  public getConfig() {
    return this.config;
  }

  constructor(client: any, config: z.infer<typeof TwitterConfigSchema>) {
    this.client = client;
    this.config = config;
  }
  private formatNFTAlert(alert: NFTAlert): string {
    const lines: string[] = [];
    if (alert.action.toUpperCase() === "SOLD") {
      lines.push(`🎨 NFT Sold: ${alert.name} for $${alert.price.toFixed(2)}`);
      if (alert.profit !== undefined) {
        lines.push(`💰 Profit: $${alert.profit.toFixed(2)}`);
      }
    } else {
      // Handle other actions like "LISTED" if needed
      lines.push(`🎨 NFT ${alert.action}: ${alert.name} at $${alert.price.toFixed(2)}`);
    }
    lines.push("#NFT #CryptoArt #AI");
    return lines.join("\n");
  }

  async postNFTAlert(alert: NFTAlert): Promise<boolean> {
    try {
      const tweetContent = this.formatNFTAlert(alert);
      if (this.config.dryRun) {
        elizaLogger.log("Dry run mode - would have posted tweet:", tweetContent);
        return true;
      }
      if (!canTweet("nft")) {
        elizaLogger.warn("NFT tweet rate limit reached");
        return false;
      }
      await this.client.post.client.twitterClient.sendTweet(tweetContent);
      elizaLogger.log("Successfully posted NFT alert to Twitter:", { content: tweetContent });
      return true;
    } catch (error) {
      elizaLogger.error("Failed to post NFT alert to Twitter:", {
        error: error instanceof Error ? error.message : String(error),
        alert,
      });
      return false;
    }
  }
    // In TwitterService class
    async postFreqTradeAlert(alert: FreqTradeAlert): Promise<boolean> {
        try {
        const tweetContent = this.formatFreqTradeAlert(alert);

        if (this.config.dryRun) {
            elizaLogger.log(
            "Dry run mode - would have posted FreqTrade tweet:",
            tweetContent,
            );
            return true;
        }

        await this.client.post.client.twitterClient.sendTweet(tweetContent);
        elizaLogger.log("Successfully posted FreqTrade alert to Twitter:", {
            content: tweetContent,
        });

        return true;
        } catch (error) {
        elizaLogger.error("Failed to post FreqTrade alert to Twitter:", {
            error: error instanceof Error ? error.message : String(error),
            alert,
        });
        return false;
        }
    }

    private formatFreqTradeAlertBackup(alert: FreqTradeAlert): string {
        const profitPrefix = alert.profit >= 0 ? "+" : "";
        const profitEmoji = alert.profit >= 5 ? "🚀" :
                            alert.profit > 0 ? "📈" :
                            alert.profit > -5 ? "📉" : "⚠️";

        const winRateEmoji = alert.winRate >= 70 ? "🎯" :
                            alert.winRate >= 50 ? "👍" : "👀";

        const lines = [
        `🤖 FreqTrade Strategy Update`,
        `📊 Strategy: ${alert.strategy} | ${alert.timeframe}`,
        //`${profitEmoji} Profit: ${profitPrefix}${alert.profit.toFixed(2)}%`,
        //`🎲 Trades: ${alert.tradeCount} | ${winRateEmoji} Win Rate: ${alert.winRate.toFixed(1)}%`,
        //alert.bestPair ? `🥇 Best: ${alert.bestPair}` : null,
        //alert.worstPair ? `🥉 Worst: ${alert.worstPair}` : null,
        `#FreqTrade #AiAgent #CryptoTrading`
        ];

        return lines.filter(Boolean).join("\n");
    }

    private formatFreqTradeAlert(alert: FreqTradeAlert): string {
        const profitPrefix = alert.profit >= 0 ? "+" : "";
        const profitEmoji = alert.profit >= 5 ? "🚀" :
                            alert.profit > 0 ? "📈" :
                            alert.profit > -5 ? "📉" : "⚠️";

        const winRateEmoji = alert.winRate >= 70 ? "🎯" :
                            alert.winRate >= 50 ? "👍" : "👀";

        // Create a pool of emojis to randomly select from
        const botEmojis = ["🤖", "🧠", "⚙️", "🔮", "💻", "🧪", "🎛️", "🚀", "🦾", "🤑"];
        const strategyEmojis = ["📊", "📈", "🎯", "💰", "⚡", "🔍", "🧩", "🛠️", "🔄", "📱"];

        // Random emoji picker
        const randomEmoji = (emojiArray: string[]) => emojiArray[Math.floor(Math.random() * emojiArray.length)];

        // Pool of interesting intro phrases
        const introPhrases = [
            `${randomEmoji(botEmojis)} FreqTrade bot is on the hunt!`,
            `${randomEmoji(botEmojis)} AI trader activated and scanning markets`,
            `${randomEmoji(botEmojis)} Trading algorithms deployed to the battlefield`,
            `${randomEmoji(botEmojis)} Digital trader unleashed on the markets`,
            `${randomEmoji(botEmojis)} Bot brain activated - seeking alpha`,
            `${randomEmoji(botEmojis)} Trade execution systems online`,
            `${randomEmoji(botEmojis)} Crypto trading algorithms initialized`,
            `${randomEmoji(botEmojis)} Markets beware - bot trader activated`,
            `${randomEmoji(botEmojis)} Automated trading sequence initiated`,
            `${randomEmoji(botEmojis)} FreqTrade strategy deployed and running`
        ];

        // Pool of strategy announcement phrases
        const strategyPhrases = [
            `${randomEmoji(strategyEmojis)} Strategy: ${alert.strategy} | Timeframe: ${alert.timeframe}`,
            `${randomEmoji(strategyEmojis)} Running "${alert.strategy}" on ${alert.timeframe} charts`,
            `${randomEmoji(strategyEmojis)} Trading with ${alert.strategy} strategy (${alert.timeframe})`,
            `${randomEmoji(strategyEmojis)} ${alert.strategy} algorithm active on ${alert.timeframe}`,
            `${randomEmoji(strategyEmojis)} Bot configured with ${alert.strategy} | ${alert.timeframe}`,
            `${randomEmoji(strategyEmojis)} ${alert.timeframe} market analysis using ${alert.strategy}`,
            `${randomEmoji(strategyEmojis)} ${alert.strategy} signals on ${alert.timeframe} timeframe`
        ];

        // Pool of market sentiment phrases
        const marketSentimentPhrases = [
            "Market conditions look promising today",
            "Volatility creating interesting opportunities",
            "Seeking profitable entries in current conditions",
            "Markets are moving - time to capitalize",
            "Looking for breakouts and momentum plays",
            "Analyzing price action for optimal entries",
            "Scanning for high-probability setups",
            "Markets never sleep, neither does this bot",
            "Aiming to catch the next big move",
            "Executing trades with mathematical precision"
        ];

        // Pool of hashtags (will randomly select a subset)
        const hashtagPool = [
            "#FreqTrade", "#AiAgent", "#CryptoTrading", "#AlgoTrading",
            "#TradingBot", "#CryptoBot", "#AutomatedTrading", "#TechnicalAnalysis",
            "#CryptoAlgo", "#BotTrading", "#CryptoStrategy", "#AITrading",
            "#QuantTrading", "#TradingAlgorithm", "#CryptoCurrency", "#TradingSystem",
            "#MarketAnalysis", "#DigitalAssets", "#ProfitHunter", "#SmartMoney"
        ];

        // Randomly select 3-5 hashtags
        const numHashtags = 3 + Math.floor(Math.random() * 3); // 3-5 hashtags
        const selectedHashtags = [...hashtagPool]
            .sort(() => 0.5 - Math.random()) // Shuffle array
            .slice(0, numHashtags)
            .join(" ");

        // Randomly select components for this tweet
        const randomIntro = introPhrases[Math.floor(Math.random() * introPhrases.length)];
        const randomStrategyPhrase = strategyPhrases[Math.floor(Math.random() * strategyPhrases.length)];

        // 50% chance to include a market sentiment phrase
        const includeSentiment = Math.random() > 0.5;
        const randomSentiment = includeSentiment ?
            marketSentimentPhrases[Math.floor(Math.random() * marketSentimentPhrases.length)] : null;

        // Build tweet components
        const lines = [
            randomIntro,
            randomStrategyPhrase,
            randomSentiment,
            selectedHashtags
        ];

        return lines.filter(Boolean).join("\n");
    }

    /**
     * Generic method to send any tweet
     * @param message The tweet content to post
     * @returns Promise<boolean> indicating success or failure
     */
    async tweetGeneric(message: string): Promise<boolean> {
        try {
            await this.client.post.client.twitterClient.sendTweet(message);
            elizaLogger.log("Successfully posted tweet to Twitter:", {
                content: message,
            });

            return true;
        } catch (error) {
            elizaLogger.error("Failed to post tweet to Twitter:", {
                error: error instanceof Error ? error.message : String(error),
                message,
            });
            return false;
        }
    }

    /**
 * Posts a trade alert to Twitter including NFT information
 * @param alert The trade alert data
 * @param nftImageUrl URL to the NFT image
 * @param nftViewUrl URL to view the NFT (marketplace or explorer)
 * @param tokenAddress Optional token address
 * @returns Promise<boolean> indicating success or failure
 */
public async postTradeAlertWithNft(
    alert: TradeBuyAlert,
    nftImageUrl: string,
    nftViewUrl: string,
    tokenAddress?: string
  ): Promise<boolean> {
    try {
      // Generate tweet text based on action type
      let tweetText: string;

      if (alert.action === "SELL") {
        // Skip sell tweets with no profit
        if (alert.profitPercent) {
            const numericProfit = parseFloat(alert.profitPercent.replace('%', ''));
            if (numericProfit <= 0) {
                elizaLogger.log(`Skipping SELL NFT tweet for ${alert.token || tokenAddress} with 0 or negative profit (${alert.profitPercent})`);
                return true; // Return true to indicate successful handling (just not posting)
            }
        }

        // Format for sell transactions
        const tokenSymbol = alert.token || tokenAddress || "Token";
        const price = alert.price ? `$${alert.price.toFixed(8)}` : "N/A";
        const trustScore = alert.trustScore || 0;

        tweetText = `SOLD $${tokenSymbol} @ ${price}\n\n`;
        tweetText += `Trust: ${trustScore} (${trustScore * 100}%)\n`;
        tweetText += `Reason: ${alert.reason || "Strategy exit"}\n\n`;

        // Add blockchain explorer link if hash exists
        if (alert.hash) {
          tweetText += `🔗 https://solscan.io/tx/${alert.hash}\n\n`;
        }

        // Add NFT information
        tweetText += `🎨 Trade NFT: ${nftViewUrl}\n`;
        tweetText += `#NFT #SolanaTrading #TradingNFT`;

      } else {
        // Buy tweet formatting
        const priceChangePrefix = alert.marketData.priceChange24h >= 0 ? "+" : "";
        const trustScoreEmoji = alert.trustScore >= 0.8 ? "🟢" : alert.trustScore >= 0.5 ? "🟡" : "🔴";

        // 24h momentum
        const momentum24h = alert.marketData.priceChange24h > 20 ? "🌋" :
          alert.marketData.priceChange24h > 10 ? "🔥" :
          alert.marketData.priceChange24h > 0 ? "📈" : "📉";

        // 5m momentum
        const momentum5m = alert.marketData.priceChange5m > 10 ? "🚀" :
          alert.marketData.priceChange5m > 5 ? "⚡" :
          alert.marketData.priceChange5m > 0 ? "💫" : "🌊";

        // Volume momentum
        const volume5m = alert.marketData.volume5m > 10000 ? "💥" :
          alert.marketData.volume5m > 5000 ? "💫" :
          alert.marketData.volume5m > 1000 ? "✨" : "💧";

        const sentiment = this.getRandomPhrase(this.BULLISH_PHRASES);
        const randomHashtags = this.getRandomElements(this.HASHTAGS, 3).join(' ');

        const lines = [
          sentiment,
          `🎯 ${alert.token} | Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(0)}%`,
          `${momentum24h} 24h: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
          `${momentum5m} 5m: ${alert.marketData.priceChange5m > 0 ? "+" : ""}${alert.marketData.priceChange5m?.toFixed(1)}%`,
          `${volume5m} 5m Vol: $${this.formatVolume(alert.marketData.volume5m)}`,
          `💲 Entry: $${alert.price?.toFixed(6)}`,
          alert.signature ? `🔍 solscan.io/tx/${alert.signature}` : null,
          `🎨 Trade NFT: ${nftViewUrl}`,
          `#SolanaPumps $${alert.token} #NFT ${randomHashtags}`,
        ];

        tweetText = lines.filter(Boolean).join("\n");
      }

      // Safety check to prevent null tweet text
      if (!tweetText || tweetText.trim() === '') {
        tweetText = `${alert.action || "TRADE"} $${alert.token || tokenAddress || "Unknown"} @ $${alert.price?.toFixed(8) || "N/A"}\n🎨 NFT: ${nftViewUrl}`;
      }

      // Check if we have a valid image URL for the NFT
      if (nftImageUrl && nftImageUrl.trim() !== '') {
        try {
          // Download the image
          const imageResponse = await fetch(nftImageUrl);
          if (!imageResponse.ok) {
            throw new Error(`Failed to fetch NFT image: ${imageResponse.status} ${imageResponse.statusText}`);
          }
          elizaLogger.log("Successfully fetched NFT image from Twitter:", {
            nftImageUrl,
            imageResponse
          });

          const imageBuffer = await imageResponse.arrayBuffer();
          elizaLogger.log("Successfully converted NFT image to buffer:", {
            imageBuffer
          });
          const mediaId = await this.client.post.client.twitterClient.uploadMedia(Buffer.from(imageBuffer));

          elizaLogger.log("Successfully uploaded NFT image to Twitter:", {
            mediaId,
            tweetText
          });
          // Send tweet with media
          await this.client.post.client.twitterClient.sendTweet({
            text: tweetText,
            media: { media_ids: [mediaId] }
          });
        } catch (mediaError) {
          elizaLogger.error("Failed to upload NFT image, sending text-only tweet:", mediaError);
          await this.client.post.client.twitterClient.sendTweet(tweetText);
        }
      } else {
        // Send text-only tweet
        await this.client.post.client.twitterClient.sendTweet(tweetText);
      }

      elizaLogger.log("Successfully posted trade NFT alert to Twitter", {
        token: alert.token,
        action: alert.action,
        nftUrl: nftViewUrl
      });

      return true;
    } catch (error) {
      elizaLogger.error("Failed to post trade NFT alert to Twitter:", error);
      return false;
    }
  }

  public async postTradeAlert(alert: TradeBuyAlert, tokenAddress?: string): Promise<boolean> {
    try {
        // Generate tweet text based on action type
        let tweetText: string;

        if (alert.action === "SELL") {
            // Skip sell tweets with no profit
            if (alert.profitPercent) {
                const numericProfit = parseFloat(alert.profitPercent.replace('%', ''));
                if (numericProfit <= 0) {
                    elizaLogger.log(`Skipping SELL tweet for ${alert.token || tokenAddress} with 0 or negative profit (${alert.profitPercent})`);
                    return true; // Return true to indicate successful handling (just not posting)
                }
            }

            // Format for sell transactions
            const tokenSymbol = alert.token || tokenAddress || "Token";
            const price = alert.price ? `$${alert.price.toFixed(8)}` : "N/A";
            const profitText = alert.profitPercent ? (alert.profitPercent.startsWith('-') ? alert.profitPercent : `+${alert.profitPercent}`) : "";
            const profitUsd = alert.profitUsd || "";

            tweetText = `SOLD $${tokenSymbol} @ ${price}\n\n`;
            const sellSentiment = this.getRandomPhrase(this.SELL_PHRASES);
            const randomHashtags = this.getRandomElements(this.HASHTAGS, 3).join(' ');

            const lines = [
                sellSentiment,
                `💰 SOLD $${tokenSymbol} @ ${price}`,
                profitText ? `📊 Result: ${profitText}` : null,
                profitUsd ? `💵 ${profitUsd}` : null,
                alert.reason ? `🔍 Reason: ${alert.reason}` : null,
                // Add blockchain explorer link if hash exists
                alert.hash ? `🔗 https://solscan.io/tx/${alert.hash}` : null,
                `$${tokenSymbol} ${randomHashtags}`
            ];

            // Filter out null/undefined lines and join with newlines
            tweetText = lines.filter(Boolean).join("\n");
        } else {
            // Original buy tweet formatting
            const priceChangePrefix = alert.marketData.priceChange24h >= 0 ? "+" : "";
            const trustScoreEmoji = alert.trustScore >= 0.8 ? "🟢" : alert.trustScore >= 0.5 ? "🟡" : "🔴";
            // 24h momentum
            const momentum24h = alert.marketData.priceChange24h > 20 ? "🌋" :
            alert.marketData.priceChange24h > 10 ? "🔥" :
            alert.marketData.priceChange24h > 0 ? "📈" : "📉";

            // 5m momentum
            const momentum5m = alert.marketData.priceChange5m > 10 ? "🚀" :
            alert.marketData.priceChange5m > 5 ? "⚡" :
            alert.marketData.priceChange5m > 0 ? "💫" : "🌊";

            // Volume momentum
            const volume5m = alert.marketData.volume5m > 10000 ? "💥" :
            alert.marketData.volume5m > 5000 ? "💫" :
            alert.marketData.volume5m > 1000 ? "✨" : "💧";

            const sentiment = this.getRandomPhrase(this.BULLISH_PHRASES);
            const randomHashtags = this.getRandomElements(this.HASHTAGS, 3).join(' ');

            const lines = [
                sentiment,
                `🎯 ${alert.token} | Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(0)}%`,
                `${momentum24h} 24h: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
                `${momentum5m} 5m: ${alert.marketData.priceChange5m > 0 ? "+" : ""}${alert.marketData.priceChange5m?.toFixed(1)}%`,
                `${volume5m} 5m Vol: $${this.formatVolume(alert.marketData.volume5m)}`,
                `💲 Entry: $${alert.price?.toFixed(6)}`,
                alert.signature ? `🔍 solscan.io/tx/${alert.signature}` : null,
                `#SolanaPumps $${alert.token} ${momentum24h} ${randomHashtags}`,
            ];

            tweetText = lines.filter(Boolean).join("\n");
        }

        // Safety check to prevent null tweet text
        if (!tweetText || tweetText.trim() === '') {
            tweetText = `${alert.action || "TRADE"} $${alert.token || tokenAddress || "Unknown"} @ $${alert.price?.toFixed(8) || "N/A"}`;
        }

        // Send tweet
        await this.client.post.client.twitterClient.sendTweet(tweetText);
        return true;
    } catch (error) {
        elizaLogger.error("Failed to post trade alert to Twitter:", error);
        return false;
    }
}

    private readonly BULLISH_PHRASES = [
        "🚀 LFG! Found a gem",
        "👀 This one's looking spicy",
        "🔥 Hot momentum alert",
        "🌙 Moonshot potential",
        "🎯 Target acquired",
        "⚡️ Lightning strike entry",
        "🔮 Crystal clear setup",
        "🎪 Step right up, next runner",
        "🌟 Star of the show",
        "🎲 Rolling the dice on this one",
        "🎭 Show's about to start",
        "🎨 Picture perfect entry",
        "🎪 Big top energy",
        "🔋 Fully charged and ready",
        "🎢 Strapped in for the ride",
        "🎯 Locked and loaded",
        "🌊 Catching the wave",
        "🎪 Center stage performer",
        "🎭 Time to shine",
        "💎 Diamond in the rough detected",
        "👑 Crown jewel of today's market",
        "🧠 Big brain trade incoming",
        "🦄 Unicorn alert! Rare opportunity",
        "🔍 Research pays off again",
        "🧪 The algorithm has spoken",
        "💡 Lightbulb moment for this ticker",
        "🎣 Hooked a juicy one",
        "🔮 The charts never lie",
        "🚦 Green light special",
        "⛵ Setting sail on profitable waters",
        "🎭 Front row seat to gains",
        "📈 Chart pattern screaming 'buy'",
        "🧙‍♂️ Magic in the markets today",
        "🔑 Unlocking value with this entry",
        "🌠 Shooting star potential",
        "🎰 Jackpot vibes on this one",
        "📊 Data-driven decision executed",
        "🎯 Bullseye opportunity spotted",
        "🌊 Riding the momentum wave",
        "🏄‍♂️ Surfing the bull market",
        "🔋 Fully charged and ready to run",
        "📱 FOMO killer activated",
        "🧠 Algorithm approves this move",
        "🧲 Attracting profits like a magnet",
        "🦅 Eagle eye spotted this gem",
        "🏎️ Zooming in for quick profits",
        "🎸 This one's about to rock",
        "🧩 Missing piece of the portfolio",
        "🌈 Found gold at the end of this rainbow",
        "🎁 Gift to future self: profits",
        "🌡️ Hot trade alert",
        "🤖 Bot says BUY",
        "🔭 Telescope locked on this moon mission",
        "⚡ Electric opportunity detected",
        "💼 Adding this to the money bag",
        "🎭 Drama incoming: profit edition",
        "🏆 Trophy asset acquired",
        "🎯 Precision entry executed",
        "🌪️ This one's brewing a storm"
    ];

    private readonly PROFIT_PHRASES = [
        "🎯 Called it perfectly",
        "💰 Bagged and tagged",
        "🏆 Another winning trade",
        "✨ Profit secured",
        "🎪 Thanks for the alpha",
        "🎭 Show's over, profits in",
        "🎪 Another successful performance",
        "🎯 Bullseye on that one",
        "💫 Magic in the markets",
        "🎭 Take a bow, winners",
        "🎪 Circus master strikes again",
        "🎨 Painted those profits",
        "🎭 Encore performance",
        "🎪 Ring master delivers",
        "🎯 Right on target",
        "🎭 Standing ovation exit",
        "🎪 Another crowd pleaser",
        "💫 Stars aligned perfectly",
        "🎭 Curtain call profits",
        "🌟 Stellar performance"
    ];

    private readonly LOSS_PHRASES = [
        "🎭 Plot twist - moving on",
        "🌊 Surf's up, next wave",
        "🎲 You win some, you learn some",
        "🔄 Reset and reload",
        "⏭️ Next play loading"
    ];

    private readonly SELL_PHRASES = [
        "💸 Cash out, cash in, and order pizza",
        "🏃‍♂️ Taking profits faster than my ex took my hoodies",
        "🎮 Just hit the sell button like it owes me money",
        "💼 Financial advisor: 'Be smart.' Me: 'Sold!'",
        "🧠 My portfolio said 'sell' but my brain heard 'yacht'",
        "🚪 Showing these profits the exit strategy I never had",
        "📱 Sold from my phone while on the toilet. Peak investing.",
        "🛒 Selling: It's like shopping, but in reverse",
        "🪙 Turning digital magic into real tacos",
        "👋 Saying goodbye, but keeping the gains",
        "🎭 Exit stage right, with pockets full",
        "🧠 Big brain move: Buy high, sell slightly less high",
        "🎯 Target acquired: Profit. Mission: Accomplished.",
        "🐔 Not diamond hands, but chicken tendies secured",
        "🏆 Trophy unlocked: Actually selling for once",
        "📈 All charts point to margarita time",
        "💰 Cashing out faster than a Vegas winner",
        "🛫 This profit is now departing for my bank account",
        "🎪 The show's over, but the popcorn was worth it",
        "🎲 Rolled the dice, didn't lose my shirt"
    ];

    private readonly HASHTAGS = [
        // Solana specific
        "#SolanaPumps",
        "#Solana",
        "#SOL",
        "#SolanaEcosystem",
        "#SolanaTrading",
        "#SolanaSZN",
        "#SolanaAlpha",
        "#SolanaDefi",
        "#SolanaNFT",
        "#SolanaNetwork",
        "#SolanaSummer",
        "#SolanaArmy",

        // General Crypto
        "#Crypto",
        "#CryptoTrading",
        "#CryptoGems",
        "#CryptoAlpha",
        "#CryptoCalls",
        "#CryptoSignals",
        "#CryptoMoonshots",
        "#Cryptocurrency",
        "#Bitcoin",
        "#Ethereum",
        "#Altcoins",
        "#DeFi",
        "#Web3",
        "#TokenEconomy",
        "#CryptoInvesting",
        "#BlockchainTech",
        "#CryptoMarket",
        "#Tokenomics",
        "#BullMarket",
        "#CryptoWinter",

        // Algorithmic/Bot Trading
        "#Algo",
        "#QuantTrading",
        "#Quant",
        "#AITrading",
        "#MLTrading",
        "#TradingAlgorithm",
        "#AICrypto",
        "#AlgoInvesting",

        // General Trading
        "#Trading",
        "#DayTrading",
        "#SwingTrading",
        "#TechnicalAnalysis",
        "#TradingStrategy",
        "#TradingTips",
        "#TradingPsychology",
        "#MarketAnalysis",
        "#ProfitSeason",
        "#FinancialFreedom",
        "#InvestorMindset",
        "#WealthCreation"
    ];

    private getRandomPhrase(phrases: string[]): string {
        return phrases[Math.floor(Math.random() * phrases.length)];
    }

    private getRandomElements(array: string[], count: number): string[] {
        const shuffled = [...array].sort(() => 0.5 - Math.random());
        return shuffled.slice(0, count);
    }

    private formatVolume(volume: number): string {
        if (volume >= 1000000) return `${(volume / 1000000).toFixed(1)}M`;
        if (volume >= 1000) return `${(volume / 1000).toFixed(1)}K`;
        return volume.toFixed(0);
    }

    private formatBuyAlert(alert: TradeBuyAlert): string {
        const priceChangePrefix = alert.marketData.priceChange24h >= 0 ? "+" : "";
        const trustScoreEmoji = alert.trustScore >= 0.8 ? "🟢" : alert.trustScore >= 0.5 ? "🟡" : "🔴";
        // 24h momentum
        const momentum24h = alert.marketData.priceChange24h > 20 ? "🌋" :
        alert.marketData.priceChange24h > 10 ? "🔥" :
        alert.marketData.priceChange24h > 0 ? "📈" : "📉";

        // 5m momentum
        const momentum5m = alert.marketData.priceChange5m > 10 ? "🚀" :
        alert.marketData.priceChange5m > 5 ? "⚡" :
        alert.marketData.priceChange5m > 0 ? "💫" : "🌊";

        // Volume momentum
        const volume5m = alert.marketData.volume5m > 10000 ? "💥" :
        alert.marketData.volume5m > 5000 ? "💫" :
        alert.marketData.volume5m > 1000 ? "✨" : "💧";

        if (alert.action === "BUY") {
            const sentiment = this.getRandomPhrase(this.BULLISH_PHRASES);
            const randomHashtags = this.getRandomElements(this.HASHTAGS, 3).join(' ');

            const lines = [
                sentiment,
                `🎯 ${alert.token} | Trust: ${trustScoreEmoji} ${(alert.trustScore * 100).toFixed(0)}%`,
                `${momentum24h} 24h: ${priceChangePrefix}${alert.marketData.priceChange24h.toFixed(1)}%`,
                `${momentum5m} 5m: ${alert.marketData.priceChange5m > 0 ? "+" : ""}${alert.marketData.priceChange5m?.toFixed(1)}%`,
                `${volume5m} 5m Vol: $${this.formatVolume(alert.marketData.volume5m)}`,
                `💲 Entry: $${alert.price?.toFixed(6)}`,
                alert.signature ? `🔍 solscan.io/tx/${alert.signature}` : null,
                `#SolanaPumps $${alert.token} ${momentum24h} ${randomHashtags}`,
            ];

            return lines.filter(Boolean).join("\n");
        }
    }

    /**
     * Posts a branding image to Twitter with a custom message
     * @param imagePath Path to the image file
     * @param message Message to accompany the image
     * @returns Promise<boolean> indicating success or failure
     */
    async postBrandingImage(imagePath: string, message: string): Promise<boolean> {
      try {
        if (this.config.dryRun) {
          elizaLogger.log("Dry run mode - would have posted branding image with message:", message);
          return true;
        }

        if (!canTweet("branding")) {
          elizaLogger.warn("Branding tweet rate limit reached");
          return false;
        }

        // Check if the image exists
        if (!fs.existsSync(imagePath)) {
          elizaLogger.error("Branding image file not found:", imagePath);
          return false;
        }

        // Read the image file
        const imageBuffer = fs.readFileSync(imagePath);

        // Upload the image to Twitter
        const mediaId = await this.client.post.client.twitterClient.uploadMedia(imageBuffer);

        elizaLogger.log("Successfully uploaded branding image to Twitter:", {
          mediaId,
          message
        });

        // Send tweet with media
        await this.client.post.client.twitterClient.sendTweet({
          text: message,
          media: { media_ids: [mediaId] }
        });

        elizaLogger.log("Successfully posted branding image to Twitter");
        return true;
      } catch (error) {
        elizaLogger.error("Failed to post branding image to Twitter:", {
          error: error instanceof Error ? error.message : String(error),
          imagePath,
          message
        });
        return false;
      }
    }

}

export interface FreqTradeAlert {
    strategy: string;
    timeframe: string;
    pair: string;
    profit: number;
    tradeCount: number;
    winRate: number;
    bestPair?: string;
    worstPair?: string;
    timestamp: number;
  }
