// arbitrage.ts
import { IAgentRuntime } from "@elizaos/core";
import { elizaLogger } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { createAirtableRecord } from "./airtable";
import { ExtendedWalletProvider } from "../types/types";

interface ArbitrageConfig {
    enabled: boolean;
    minProfitPercent: number;
    maxSlippage: number;
    scanInterval: number;
    exchanges: string[];
}
interface PriceQuote {
    exchange: string;
    price: number;
}
interface ArbitrageOpportunity {
    buyExchange: string;
    sellExchange: string;
    buyPrice: number;
    sellPrice: number;
    profitPercent: number;
}

export class ArbitrageManager {
    private config: ArbitrageConfig;
    private runtime: IAgentRuntime;
    private wallet: ExtendedWalletProvider;
    private scanIntervalId: NodeJS.Timeout | null = null;
    private isScanning: boolean = false;

    constructor(config: ArbitrageConfig, runtime: IAgentRuntime, wallet: ExtendedWalletProvider) {
        this.config = config;
        this.runtime = runtime;
        this.wallet = wallet;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            elizaLogger.log("Arbitrage manager is disabled");
            return;
        }
        elizaLogger.log("Starting Arbitrage manager");
        // Periodically scan for opportunities
        this.scanIntervalId = setInterval(async () => {
            if (!this.isScanning) {
                await this.scanForOpportunities();
            }
        }, this.config.scanInterval);
        elizaLogger.log("Arbitrage manager started successfully");
    }

    private async scanForOpportunities(): Promise<void> {
        this.isScanning = true;
        try {
            elizaLogger.log("Scanning for arbitrage opportunities...");
            const tokens = await this.getTokensToScan();
            for (const token of tokens) {
                const prices = await this.getPricesAcrossExchanges(token);
                const opportunity = this.findArbitrageOpportunity(prices);
                if (opportunity) {
                    elizaLogger.log(`Found arbitrage opportunity for ${token}:`, opportunity);
                    // Log the opportunity in Airtable
                    const jobId = uuidv4();
                    createAirtableRecord({
                        "JobID": jobId,
                        "StartDatetime": new Date().toISOString(),
                        "ProcessType": "Arbitrage",
                        "Token": token,
                        "BuyExchange": opportunity.buyExchange,
                        "SellExchange": opportunity.sellExchange,
                        "ProfitPercent": opportunity.profitPercent.toFixed(2)
                    }, this.runtime, "ArbitrageOpportunities");
                    // Execute trade if profit meets threshold
                    if (opportunity.profitPercent > this.config.minProfitPercent) {
                        await this.executeArbitrage(token, opportunity);
                    }
                }
            }
        } catch (error) {
            elizaLogger.error("Error scanning for arbitrage opportunities:", error);
        } finally {
            this.isScanning = false;
        }
    }

    private async getTokensToScan(): Promise<string[]> {
        // Tokens to monitor for arbitrage (could be dynamic or configured)
        return ["SOL", "ETH", "BTC", "USDC"];
    }

    private async getPricesAcrossExchanges(token: string): Promise<PriceQuote[]> {
        // Simulate price quotes from different exchanges for the given token
        const basePrices: { [symbol: string]: number } = {
            "SOL": 20,
            "ETH": 1500,
            "BTC": 30000,
            "USDC": 1
        };
        const basePrice = basePrices[token] || 1;
        const quotes: PriceQuote[] = [];
        for (const exchange of this.config.exchanges) {
            // Apply a random variation of ±2% to simulate price differences
            const variation = (Math.random() * 0.04) - 0.02;
            const price = basePrice * (1 + variation);
            quotes.push({ exchange, price });
        }
        return quotes;
    }

    private findArbitrageOpportunity(prices: PriceQuote[]): ArbitrageOpportunity | null {
        if (prices.length === 0) return null;
        // Identify min and max prices across exchanges
        let minPrice = Infinity;
        let maxPrice = -Infinity;
        let buyExchange = "";
        let sellExchange = "";
        for (const quote of prices) {
            if (quote.price < minPrice) {
                minPrice = quote.price;
                buyExchange = quote.exchange;
            }
            if (quote.price > maxPrice) {
                maxPrice = quote.price;
                sellExchange = quote.exchange;
            }
        }
        const profitPercent = ((maxPrice - minPrice) / minPrice) * 100;
        // Only consider if profit exceeds minProfit + slippage buffer
        if (profitPercent > (this.config.minProfitPercent + this.config.maxSlippage)) {
            return { buyExchange, sellExchange, buyPrice: minPrice, sellPrice: maxPrice, profitPercent };
        }
        return null;
    }

    private async executeArbitrage(token: string, opportunity: ArbitrageOpportunity): Promise<void> {
        try {
            // Simulate executing the arbitrage trade
            const tradeVolumeUSD = 1000;  // assume $1000 trade size for profit calc
            const profitUSD = (opportunity.profitPercent / 100) * tradeVolumeUSD;
            elizaLogger.log(
                `Executing arbitrage for ${token}: Buy on ${opportunity.buyExchange} at $${opportunity.buyPrice.toFixed(4)}, ` +
                `sell on ${opportunity.sellExchange} at $${opportunity.sellPrice.toFixed(4)}, ` +
                `expected profit ~${opportunity.profitPercent.toFixed(2)}% ($${profitUSD.toFixed(2)})`
            );
            // Log the executed trade in Airtable
            const execJobId = uuidv4();
            createAirtableRecord({
                "JobID": execJobId,
                "StartDatetime": new Date().toISOString(),
                "ProcessType": "ArbitrageTrade",
                "Token": token,
                "BuyExchange": opportunity.buyExchange,
                "SellExchange": opportunity.sellExchange,
                "ProfitPercent": opportunity.profitPercent.toFixed(2),
                "ProfitUSD": profitUSD.toFixed(2)
            }, this.runtime, "ArbitrageTrades");
            elizaLogger.log(`Arbitrage trade completed for ${token} with profit $${profitUSD.toFixed(2)}`);
        } catch (error) {
            elizaLogger.error("Error executing arbitrage trade:", error);
        }
    }

    async stop(): Promise<void> {
        if (this.scanIntervalId) {
            clearInterval(this.scanIntervalId);
        }
        elizaLogger.log("Arbitrage manager stopped");
    }
}
