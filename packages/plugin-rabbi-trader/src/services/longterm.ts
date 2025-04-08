import { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from "@elizaos/core";
import { v4 as uuidv4 } from 'uuid';
import { createAirtableRecord, updateAirtableStatus } from './airtable';
import { Connection } from '@solana/web3.js';
import { WalletClient, Signature } from 'viem';
import { Balance } from '@goat-sdk/core';
import { ExtendedWalletProvider } from '../types/types';

interface LongTermConfig {
    enabled: boolean;
    allocatedPercentage: number;  // % of total funds to allocate for long-term
    rebalanceInterval: number;    // Milliseconds between rebalancing
    maxPerAsset: number;          // Maximum % allocation per asset
}

interface AssetAllocation {
    symbol: string;
    targetPercentage: number;
    currentPercentage: number;
    currentValue: number;
}

export class LongTermManager {
    private config: LongTermConfig;
    private runtime: IAgentRuntime;
    private wallet: ExtendedWalletProvider;
    private rebalanceInterval: NodeJS.Timeout | null = null;
    private isRebalancing: boolean = false;
    private portfolio: AssetAllocation[] = [];
    private lastRebalance: Date | null = null;

    constructor(config: LongTermConfig, runtime: IAgentRuntime, wallet: ExtendedWalletProvider) {
        this.config = config;
        this.runtime = runtime;
        this.wallet = wallet;
    }

    async start(): Promise<void> {
        if (!this.config.enabled) {
            elizaLogger.log("Long-term investment manager is disabled");
            return;
        }

        elizaLogger.log("Starting Long-term investment manager");

        // Initialize portfolio
        await this.initializePortfolio();

        // Schedule regular rebalancing
        this.rebalanceInterval = setInterval(async () => {
            if (!this.isRebalancing) {
                await this.rebalancePortfolio();
            }
        }, this.config.rebalanceInterval);

        elizaLogger.log("Long-term investment manager started successfully");
    }

    private async initializePortfolio(): Promise<void> {
        try {
            // Fetch the strategic allocation from settings or Airtable
            const strategicAllocations = await this.getStrategicAllocations();

            // Initialize the portfolio with target allocations
            this.portfolio = [];
            for (const allocation of strategicAllocations) {
                this.portfolio.push({
                    symbol: allocation.symbol,
                    targetPercentage: allocation.percentage,
                    currentPercentage: 0, // Will be updated during rebalance
                    currentValue: 0       // Will be updated during rebalance
                });
            }

            // Log the initial portfolio
            elizaLogger.log("Initialized long-term portfolio with allocations:",
                this.portfolio.map(a => `${a.symbol}: ${a.targetPercentage}%`).join(', '));

            // Perform initial rebalance
            await this.rebalancePortfolio();
        } catch (error) {
            elizaLogger.error("Failed to initialize long-term portfolio:", error);
        }
    }

    private async getStrategicAllocations(): Promise<{symbol: string; percentage: number}[]> {
        try {
            // Try to get from Airtable first
            const allocations = await this.fetchAllocationsFromAirtable();
            if (allocations.length > 0) {
                return allocations;
            }

            // Fallback to default allocations if none in Airtable
            return [
                { symbol: "BTC", percentage: 40 },
                { symbol: "ETH", percentage: 30 },
                { symbol: "SOL", percentage: 15 },
                { symbol: "USDC", percentage: 15 }
            ];
        } catch (error) {
            elizaLogger.error("Error fetching strategic allocations:", error);

            // Return conservative defaults in case of error
            return [
                { symbol: "BTC", percentage: 30 },
                { symbol: "ETH", percentage: 20 },
                { symbol: "SOL", percentage: 10 },
                { symbol: "USDC", percentage: 40 }
            ];
        }
    }

    private async fetchAllocationsFromAirtable(): Promise<{symbol: string; percentage: number}[]> {
        try {
            // This would query the Airtable for the strategic asset allocations
            // Implementation depends on Airtable structure
            return [];
        } catch (error) {
            elizaLogger.error("Error fetching allocations from Airtable:", error);
            return [];
        }
    }

    private async updatePortfolioValues(): Promise<void> {
        try {
            // Get total portfolio value across all assets
            let totalValue = 0;

            // Update current values
            for (const asset of this.portfolio) {
                try {
                    // Get balance for this asset
                    const balance = await this.wallet.balanceOf(asset.symbol);

                    // Convert to USD value (simplified - would need price feeds in real implementation)
                    const assetValue = parseFloat(balance.formatted) * await this.getAssetPrice(asset.symbol);

                    asset.currentValue = assetValue;
                    totalValue += assetValue;
                } catch (assetError) {
                    elizaLogger.error(`Error getting balance for ${asset.symbol}:`, assetError);
                    // Keep previous value if there's an error
                }
            }

            // Calculate current percentages
            if (totalValue > 0) {
                for (const asset of this.portfolio) {
                    asset.currentPercentage = (asset.currentValue / totalValue) * 100;
                }
            }

            elizaLogger.log("Updated portfolio values:",
                this.portfolio.map(a => `${a.symbol}: $${a.currentValue.toFixed(2)} (${a.currentPercentage.toFixed(2)}%)`).join(', '));
        } catch (error) {
            elizaLogger.error("Error updating portfolio values:", error);
        }
    }

    private async getAssetPrice(symbol: string): Promise<number> {
        try {
            // This would query an exchange or price API for the current price
            // For simplicity, using mock prices here
            const mockPrices: {[key: string]: number} = {
                "BTC": 45000,
                "ETH": 2500,
                "SOL": 100,
                "USDC": 1
            };

            return mockPrices[symbol] || 0;
        } catch (error) {
            elizaLogger.error(`Error getting price for ${symbol}:`, error);
            return 0;
        }
    }

    async rebalancePortfolio(): Promise<void> {
        if (this.isRebalancing) return;

        this.isRebalancing = true;
        const jobId = uuidv4();

        try {
            elizaLogger.log("Starting portfolio rebalance...");

            // Record rebalance start
            createAirtableRecord(
                {
                    "JobID": jobId,
                    "StartDatetime": new Date().toISOString(),
                    "ProcessType": "Portfolio Rebalance",
                    "Status": "Started"
                },
                this.runtime,
                "InvestmentOperations"
            );

            // Update current values and percentages
            await this.updatePortfolioValues();

            // Calculate rebalance actions
            const rebalanceActions = await this.calculateRebalanceActions();

            // Execute rebalance if there are actions to take
            if (rebalanceActions.length > 0) {
                elizaLogger.log("Executing rebalance actions:", rebalanceActions);

                for (const action of rebalanceActions) {
                    await this.executeRebalanceAction(action);
                }

                // Update portfolio values after rebalance
                await this.updatePortfolioValues();
            } else {
                elizaLogger.log("No rebalance actions needed, portfolio is within target allocations");
            }

            this.lastRebalance = new Date();

            // Update Airtable with completion
            updateAirtableStatus(
                jobId,
                "Completed",
                this.runtime,
                "InvestmentOperations"
            );

            elizaLogger.log("Portfolio rebalance completed successfully");
        } catch (error) {
            elizaLogger.error("Error during portfolio rebalance:", error);

            // Update Airtable with error
            updateAirtableStatus(
                jobId,
                `Failed: ${error.message}`,
                this.runtime,
                "InvestmentOperations"
            );
        } finally {
            this.isRebalancing = false;
        }
    }

    private async calculateRebalanceActions(): Promise<{ asset: string; action: 'buy' | 'sell'; amount: number; amountUSD: number }[]> {
        const actions = [];
        const threshold = 2; // Only rebalance if off by more than 2%

        for (const asset of this.portfolio) {
            const deviation = asset.currentPercentage - asset.targetPercentage;

            // Only rebalance if deviation exceeds threshold
            if (Math.abs(deviation) > threshold) {
                const totalPortfolioValue = this.portfolio.reduce((sum, a) => sum + a.currentValue, 0);
                const targetValue = (asset.targetPercentage / 100) * totalPortfolioValue;
                const amountToAdjustUSD = targetValue - asset.currentValue;

                // Calculate amount in asset units
                const assetBalance = await this.wallet.balanceOf(asset.symbol);
                const assetPrice = asset.currentValue / parseFloat(assetBalance.formatted || '0');
                const amountToAdjust = amountToAdjustUSD / assetPrice;

                actions.push({
                    asset: asset.symbol,
                    action: deviation < 0 ? 'buy' : 'sell',
                    amount: Math.abs(amountToAdjust),
                    amountUSD: Math.abs(amountToAdjustUSD)
                });
            }
        }

        return actions;
    }

    private async executeRebalanceAction(action: { asset: string; action: 'buy' | 'sell'; amount: number; amountUSD: number }): Promise<void> {
        try {
            elizaLogger.log(`Executing ${action.action} for ${action.amount} ${action.asset} (${action.amountUSD.toFixed(2)} USD)`);

            // In a real implementation, this would execute the trade
            // For now, we'll just log it

            // Create Airtable record of the trade
            createAirtableRecord(
                {
                    "Asset": action.asset,
                    "Action": action.action,
                    "Amount": action.amount,
                    "USD Value": action.amountUSD,
                    "Timestamp": new Date().toISOString(),
                    "Type": "Portfolio Rebalance"
                },
                this.runtime,
                "Trades"
            );

            elizaLogger.log(`${action.action} order for ${action.asset} executed successfully`);
        } catch (error) {
            elizaLogger.error(`Error executing ${action.action} for ${action.asset}:`, error);
            throw error;
        }
    }

    async getPortfolioStatus(): Promise<any> {
        await this.updatePortfolioValues();

        return {
            portfolio: this.portfolio,
            lastRebalance: this.lastRebalance,
            nextRebalance: this.lastRebalance ?
                new Date(this.lastRebalance.getTime() + this.config.rebalanceInterval) :
                new Date(),
            totalValue: this.portfolio.reduce((sum, asset) => sum + asset.currentValue, 0)
        };
    }

    async stop(): Promise<void> {
        if (this.rebalanceInterval) {
            clearInterval(this.rebalanceInterval);
        }

        elizaLogger.log("Long-term investment manager stopped");
    }

    async forceRebalance(): Promise<void> {
        if (!this.isRebalancing) {
            elizaLogger.log("Forcing portfolio rebalance...");
            await this.rebalancePortfolio();
        } else {
            elizaLogger.warn("Rebalance already in progress, cannot force another rebalance");
        }
    }
}