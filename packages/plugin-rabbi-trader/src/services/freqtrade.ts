import { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from "@elizaos/core";
import { FreqTradeAlert, tweetTrade, TwitterService } from '../services/twitter';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createAirtableRecord, updateFreqtradeAirtableStatus } from './airtable';

export interface FreqtradeConfig {
    enabled: boolean;
    scriptPath: string;
    resultsPath: string;
    logsPath: string;
    monitorInterval: number;
    performanceThreshold: number;
    optimizationInterval: number;
    logPath: string;
}

export class FreqtradeManager {
    private config: FreqtradeConfig;
    private runtime: IAgentRuntime;
    private isRunning: boolean = false;
    private isOptimizing: boolean = false;
    private optimizationInterval: NodeJS.Timeout | null = null;
    private monitorInterval: NodeJS.Timeout | null = null;
    private lastPerformance: number = 0;

    constructor(config: FreqtradeConfig, runtime: IAgentRuntime) {
        this.config = config;
        this.runtime = runtime;
    }

    async start(twitterService?: TwitterService): Promise<void> {
        elizaLogger.log("Starting FreqTrade manager");

        await this.runOptimizationWorkflow(twitterService);

        this.startMonitoring(twitterService);

        elizaLogger.log("FreqTrade manager started successfully");
    }

    private async runOptimizationWorkflow(twitterService: TwitterService) {
        if (this.isOptimizing) return;
        this.isOptimizing = true;

        try {
            const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const downloadDataLogFilePath = path.join(this.config.logsPath, `download_data_${today}.log`);

            // Step 1: Download fresh market data
            elizaLogger.log(`Starting FreqTrade optimization workflow`);
            let jobId = uuidv4();
            let processType = "Download Data";
            if (fs.existsSync(downloadDataLogFilePath)) {
                elizaLogger.log(`Market data already downloaded today. Log file exists: ${downloadDataLogFilePath}`);
            } else {
                // Create Airtable record
                createAirtableRecord(
                    {
                        "JobID": jobId,
                        "StartDatetime": new Date().toISOString(),
                        "ProcessType": processType
                    },
                    this.runtime,
                    "FreqtradeProcessing"
                );
                elizaLogger.log("FreqtradeManager: Downloading market data...");
                await this.executeScript('download_data.sh');
                updateFreqtradeAirtableStatus(jobId, processType, this.runtime);
            }

            // Step 2: Optimize parameters for strategy
            const optimizationNeeded = await this.isOptimizationNeeded();
            if (optimizationNeeded) {
                elizaLogger.log(`Starting FreqTrade optimization workflow`);
                jobId = uuidv4();
                processType = "Optimize Parameters";
                createAirtableRecord(
                    {
                        "JobID": jobId,
                        "StartDatetime": new Date().toISOString(),
                        "ProcessType": processType
                    },
                    this.runtime,
                    "FreqtradeProcessing"
                );
                elizaLogger.log("FreqtradeManager: Optimizing trading parameters...");
                await this.executeScript('optimize_parameters.sh');
                updateFreqtradeAirtableStatus(jobId, processType, this.runtime);
            } else {
                elizaLogger.log("Skipping optimization as it was run within the past 3 days");
            }

            // Step 3: Run backtests to find best strategy
            const backtestNeeded = true;//await this.isBacktestNeeded();
            if (backtestNeeded) {
                elizaLogger.log(`Starting FreqTrade backtest workflow`);
                jobId = uuidv4();
                processType = "Backtest Data";
                createAirtableRecord(
                    {
                        "JobID": jobId,
                        "StartDatetime": new Date().toISOString(),
                        "ProcessType": processType
                    },
                    this.runtime,
                    "FreqtradeProcessing"
                );
                elizaLogger.log("FreqtradeManager: Backtesting strategies...");
                await this.executeScript('backtest_data.sh');
                updateFreqtradeAirtableStatus(jobId, processType, this.runtime);
            } else {
                elizaLogger.log("Skipping backtest as conditions not met");
            }

            // Step 4: Deploy the bot with optimized strategy
            elizaLogger.log(`Starting FreqTrade deploy bot workflow`);
            const currentDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
            elizaLogger.log(`deploy_bot Current date: ${currentDate}`);
            const strategyFilePath = path.join(this.config.resultsPath, `deploy_strategy_kraken_${currentDate}.txt`);
            elizaLogger.log(`deploy_bot Strategy file path: ${strategyFilePath}`);
            let strategyName = "ScalpingStrategy"; // Default
            let timeframe = "1h"; // Default
            let bestPair = "ETH/USDT"; // Default
            let worstPair = "DOGE/USDT"; // Default
            let totalProfit = 0; // Default
            let tradeCount = 0; // Default
            let winRate = 0; // Default
            try {
                if (fs.existsSync(strategyFilePath)) {
                    const fileContent = fs.readFileSync(strategyFilePath, 'utf8');
                    const lines = fileContent.split('\n');
                    elizaLogger.log(`deploy_bot File content: ${fileContent}`);
                    // Parse each line for values
                    for (const line of lines) {
                        elizaLogger.log(`deploy_bot Line: ${line}`);
                        if (line.includes(':')) {
                            const [key, value] = line.split(':', 2).map(part => part.trim());
                            elizaLogger.log(`deploy_bot Key: ${key}, Value: ${value}`);
                            if (key === 'Best Strategy') {
                                strategyName = value;
                            } else if (key === 'Timeframe') {
                                timeframe = value;
                            } else if (key === 'Best Pair') {
                                bestPair = value !== 'Not found' ? value : "ETH/USDT";
                            } else if (key === 'Worst Pair') {
                                worstPair = value !== 'Not found' ? value : "DOGE/USDT";
                            } else if (key === 'Total Profit') {
                                // Extract numeric value from "0%" format
                                totalProfit = parseFloat(value.replace('%', '')) || 0;
                            } else if (key === 'Trade Count') {
                                // Extract numeric value from "0%" format
                                tradeCount = parseFloat(value.replace('%', '')) || 0;
                            } else if (key === 'Win Rate') {
                                // Extract numeric value from "0%" format
                                winRate = parseFloat(value.replace('%', '')) || 0;
                            }
                            elizaLogger.log(`deploy_bot Key: ${key}, Value: ${value}`);
                        }
                    }

                    elizaLogger.log(`Found strategy details to deploy:`, {
                        strategyName,
                        timeframe,
                        bestPair,
                        worstPair,
                        totalProfit
                    });
                } else {
                    elizaLogger.warn(`Strategy file not found: ${strategyFilePath}, using default values`);
                }
            } catch (error) {
                elizaLogger.error(`Error reading strategy file: ${error}`);
            }

            jobId = uuidv4();
            processType = "Deploy Bot";
            createAirtableRecord(
                {
                    "JobID": jobId,
                    "StartDatetime": new Date().toISOString(),
                    "ProcessType": processType
                },
                this.runtime,
                "FreqtradeProcessing"
            );

            elizaLogger.log(`FreqtradeManager: Deploying bot with optimized strategy: ${strategyName}`);
            await this.executeScript('deploy_bot.sh');
            updateFreqtradeAirtableStatus(jobId, processType, this.runtime);

            const freqTradeResults = {
                strategy: strategyName,
                timeframe: timeframe,
                pair: bestPair,
                profit: totalProfit,
                tradeCount: tradeCount,
                winRate: winRate,
                bestPair: bestPair,
                worstPair: worstPair
            };
            // Send FreqTrade update tweet
            await tweetTrade(
                twitterService,
                freqTradeResults as FreqTradeAlert,
                "FreqTrade"  // Special token address to trigger FreqTrade path
            );
            this.isRunning = true;
            elizaLogger.log("FreqTrade optimization workflow completed successfully");
        } catch (error) {
            elizaLogger.error("Error during FreqTrade optimization workflow:", error);
        } finally {
            this.isOptimizing = false;
        }
    }

    private executeScript(scriptName: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const fullPath = path.join(this.config.scriptPath, scriptName);
            elizaLogger.log(`Executing ${scriptName}...`);

            exec(`bash ${fullPath}`, (error, stdout, stderr) => {
                if (error) {
                    elizaLogger.error(`Error executing ${scriptName}:`, {
                        error,
                        stdout,
                        stderr
                    });
                    reject(error);
                    return;
                }

                elizaLogger.log(`${scriptName} executed successfully:`, {
                    output: stdout.substring(0, 200) + (stdout.length > 200 ? '...' : '')
                });
                resolve();
            });
        });
    }

    private async isBacktestNeeded(): Promise<boolean> {
        try {
            const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
            const logDir = path.join(this.config.logsPath);
            let optimizationRanToday = false;
            let backtestRanToday = false;

            if (fs.existsSync(logDir)) {
                const files = fs.readdirSync(logDir);

                // Check for today's optimization file
                const todayOptimizeFile = files.find(file => file.startsWith(`optimize_manual_${today}`));
                optimizationRanToday = !!todayOptimizeFile;

                // Check for today's backtest file
                const todayBacktestFile = files.find(file => file.startsWith(`backtest_${today}`));
                backtestRanToday = !!todayBacktestFile;
            }

            // If backtest already ran today, no need to run again
            if (backtestRanToday) {
                elizaLogger.log(`Backtest already run today. Log file exists.`);
                return false;
            }

            // If no optimization ran today, don't run backtest
            if (!optimizationRanToday) {
                elizaLogger.log(`No optimization run today. Skipping backtest.`);
                return false;
            }

            // Optimization ran today but backtest hasn't - backtest is needed
            elizaLogger.log(`Optimization ran today but backtest hasn't. Backtest needed.`);
            return true;
        } catch (error) {
            elizaLogger.error(`Error checking backtest logs: ${error}`);
            // If error occurs, default to running backtest
            return true;
        }
    }

    private async isOptimizationNeeded(): Promise<boolean> {
        try {
            const logsDir = path.join(this.config.logsPath);
            const files = fs.readdirSync(logsDir);

            // Get current date and date from 3 days ago
            const currentDate = new Date();
            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(currentDate.getDate() - 3);

            // Check if any optimization files exist from the last 3 days
            for (const file of files) {
                if (file.startsWith('optimize_manual_')) {
                    // Extract date from filename (format: optimize_manual_YYYYMMDD_HHMMSS.log)
                    const dateMatch = file.match(/optimize_manual_(\d{8})_/);

                    if (dateMatch && dateMatch[1]) {
                        const dateStr = dateMatch[1];
                        // Parse YYYYMMDD format
                        const year = parseInt(dateStr.substring(0, 4));
                        const month = parseInt(dateStr.substring(4, 6)) - 1; // JS months are 0-based
                        const day = parseInt(dateStr.substring(6, 8));

                        const fileDate = new Date(year, month, day);

                        // If file is newer than 3 days ago, optimization is not needed
                        if (fileDate >= threeDaysAgo) {
                            elizaLogger.log(`Found recent optimization log: ${file} from ${fileDate.toISOString().split('T')[0]}`);
                            return false;
                        }
                    }
                }
            }

            // No recent optimization files found
            elizaLogger.log(`No optimization logs found within the last 3 days. Optimization needed.`);
            return true;
        } catch (error) {
            elizaLogger.error(`Error checking optimization logs: ${error}`);
            // If error occurs, default to running optimization
            return true;
        }
    }

    private async getTradeStats(): Promise<{ totalTrades: number, winRate: number, bestPair: string, worstPair: string }> {
        try {
            // Try to read from log or stats file - adjust based on how FreqTrade outputs stats
            const logContent = fs.readFileSync(this.config.logPath, 'utf8');

            // Default values
            let totalTrades = 0;
            let winRate = 0;
            let bestPair = "ETH/USDT"; // Default
            let worstPair = "DOGE/USDT"; // Default

            // Extract stats from logs using regex - adjust patterns based on log format
            const tradesMatch = logContent.match(/Total trades: (\d+)/);
            const winRateMatch = logContent.match(/Win rate: (\d+\.?\d*)%/);
            const bestPairMatch = logContent.match(/Best pair: ([A-Z]+\/[A-Z]+)/);
            const worstPairMatch = logContent.match(/Worst pair: ([A-Z]+\/[A-Z]+)/);

            if (tradesMatch) totalTrades = parseInt(tradesMatch[1]);
            if (winRateMatch) winRate = parseFloat(winRateMatch[1]);
            if (bestPairMatch) bestPair = bestPairMatch[1];
            if (worstPairMatch) worstPair = worstPairMatch[1];

            return { totalTrades, winRate, bestPair, worstPair };
        } catch (error) {
            elizaLogger.error("Error retrieving trade stats:", error);
            return { totalTrades: 0, winRate: 0, bestPair: "ETH/USDT", worstPair: "DOGE/USDT" };
        }
    }
    private async getCurrentStrategy(): Promise<string> {
        try {
            // Read from config or log file to determine current strategy
            const configPath = path.join(this.config.scriptPath, 'config.json');
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return configData.strategy || "FreqTrade";
        } catch (error) {
            elizaLogger.error("Error getting current strategy:", error);
            return "FreqTrade";
        }
    }

    private async getCurrentTimeframe(): Promise<string> {
        try {
            // Read from config or log file to determine current timeframe
            const configPath = path.join(this.config.scriptPath, 'config.json');
            const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            return configData.timeframe || "Auto";
        } catch (error) {
            elizaLogger.error("Error getting current timeframe:", error);
            return "Auto";
        }
    }
    private startMonitoring(twitterService?: TwitterService, imageGenerator?: any) {
        if (this.monitorInterval) clearInterval(this.monitorInterval);

        this.monitorInterval = setInterval(async () => {
            if (this.isOptimizing) return; // Skip monitoring during optimization

            try {
                // Check for scheduled daily shutdown between 3:33 AM and 3:35 AM CST
                const now = new Date();
                // Convert to Central Time (CST/CDT)
                const cstOptions = { timeZone: 'America/Chicago' };
                const cstTime = new Date(now.toLocaleString('en-US', cstOptions));

                const hours = cstTime.getHours();
                const minutes = cstTime.getMinutes();

                // If it's between 3:33 AM and bot is running, capture results and shut down
                if (hours === 3 && minutes >= 33 && minutes <= 35 && this.isRunning) {
                    elizaLogger.log(`Scheduled daily shutdown at ${hours}:${minutes} AM CST. Stopping FreqTrade bot.`);

                    try {
                        // Get final performance metrics for the day
                        const performance = await this.getPerformance();
                        const tradeStats = await this.getTradeStats();

                        // Create alert with day's trading summary
                        const dailySummary: FreqTradeAlert = {
                            strategy: await this.getCurrentStrategy() || "FreqTrade",
                            timeframe: await this.getCurrentTimeframe() || "Auto",
                            pair: "Daily Summary",
                            profit: performance,
                            tradeCount: tradeStats.totalTrades || 0,
                            winRate: tradeStats.winRate || 0,
                            bestPair: tradeStats.bestPair,
                            worstPair: tradeStats.worstPair,
                            timestamp: Date.now()
                        };

                        // Post daily summary with image if services are available
                        if (twitterService && imageGenerator) {
                            await twitterService.postFreqTradeAlert(dailySummary);
                        } else if (twitterService) {
                            // Fall back to text-only tweet if image generator isn't available
                            await twitterService.postFreqTradeAlert(dailySummary);
                        }
                    } catch (summaryError) {
                        elizaLogger.error("Error creating trade summary:", summaryError);
                    }

                    await this.stopBot();
                    elizaLogger.log("FreqTrade bot stopped for scheduled maintenance. Will restart on next system boot.");
                    return;
                }
            } catch (error) {
                elizaLogger.error("Error monitoring FreqTrade:", error);
            }
        }, this.config.monitorInterval);
    }

    private async getPerformance(): Promise<number> {
        try {
            const logContent = fs.readFileSync(this.config.logPath, 'utf8');
            // Extract profit data - adjust regex based on your log format
            const profitMatch = logContent.match(/Current portfolio profit: (\-?\d+\.\d+)%/);
            return profitMatch ? parseFloat(profitMatch[1]) : 0;
        } catch (error) {
            elizaLogger.error("Failed to get FreqTrade performance:", error);
            return 0;
        }
    }

    private async stopBot(): Promise<void> {
        if (!this.isRunning) return;

        try {
            await this.executeScript('stop_bot.sh'); // You'll need to create this script
            this.isRunning = false;
            elizaLogger.log("FreqTrade bot stopped successfully");
        } catch (error) {
            elizaLogger.error("Failed to stop FreqTrade bot:", error);
        }
    }

    async stop() {
        if (this.optimizationInterval) clearInterval(this.optimizationInterval);
        if (this.monitorInterval) clearInterval(this.monitorInterval);

        await this.stopBot();
        elizaLogger.log("FreqTrade manager stopped");
    }
}