// import {
//     IAgentRuntime,
//     elizaLogger,
//     State,
//     Provider
// } from "@elizaos/core";
// import { Connection, PublicKey } from "@solana/web3.js";
// import { getWalletKey } from "./utils";
// import { TokenProvider } from "./token";
// import { TrustScoreProvider } from "./providers/trustScoreProvider";

// interface AutoTradeConfig {
//     minTrustScore: number;
//     maxSlippage: number;
//     minLiquidity: number;
//     targetProfitPercent: number;
//     stopLossPercent: number;
//     maxPositions: number;
// }

// export class SwapProvider implements Provider {
//     private connection: Connection;
//     private tokenProvider: TokenProvider;
//     private trustScoreProvider: TrustScoreProvider;
//     private isAutoTrading: boolean = false;
//     private config: AutoTradeConfig;

//     constructor(connection: Connection) {
//         this.connection = connection;
//         this.tokenProvider = new TokenProvider(connection);
//         this.trustScoreProvider = new TrustScoreProvider(connection);

//         // Default auto-trade configuration
//         this.config = {
//             minTrustScore: 70,
//             maxSlippage: 1.0,
//             minLiquidity: 10000,
//             targetProfitPercent: 5,
//             stopLossPercent: 2.5,
//             maxPositions: 3
//         };
//     }

//     async startAutoTrading(runtime: IAgentRuntime): Promise<void> {
//         if (this.isAutoTrading) return;

//         this.isAutoTrading = true;
//         await this.autoTradeLoop(runtime);
//     }

//     async stopAutoTrading(): Promise<void> {
//         this.isAutoTrading = false;
//     }

//     private async autoTradeLoop(runtime: IAgentRuntime): Promise<void> {
//         while (this.isAutoTrading) {
//             try {
//                 // 1. Find new opportunities
//                 const opportunities = await this.findNewTokensToBuy(runtime);

//                 // 2. Evaluate each opportunity
//                 for (const token of opportunities) {
//                     const evaluation = await this.evaluateToken(token, runtime);

//                     if (evaluation.shouldBuy) {
//                         await this.executeBuy(token.address, evaluation.amount, runtime);
//                     }
//                 }

//                 // 3. Check existing positions
//                 const positions = await this.getCurrentPositions(runtime);
//                 for (const position of positions) {
//                     const shouldSell = await this.evaluatePosition(position);
//                     if (shouldSell) {
//                         await this.executeSell(position.tokenAddress, position.amount, runtime);
//                     }
//                 }

//                 // Wait before next iteration
//                 await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second delay

//             } catch (error) {
//                 elizaLogger.error("Error in auto trade loop:", error);
//                 await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay on error
//             }
//         }
//     }

//     private async findNewTokensToBuy(runtime: IAgentRuntime): Promise<any[]> {
//         try {
//             const tokens = await this.tokenProvider.getNewTokens();
//             return tokens.filter(async token => {
//                 const trustScore = await this.trustScoreProvider.getScore(token.address);
//                 return trustScore >= this.config.minTrustScore;
//             });
//         } catch (error) {
//             elizaLogger.error("Error finding new tokens:", error);
//             return [];
//         }
//     }

//     private async evaluateToken(token: any, runtime: IAgentRuntime): Promise<{
//         shouldBuy: boolean;
//         amount: number;
//     }> {
//         try {
//             const liquidity = await this.tokenProvider.getLiquidity(token.address);
//             const trustScore = await this.trustScoreProvider.getScore(token.address);
//             const price = await this.tokenProvider.getPrice(token.address);

//             return {
//                 shouldBuy:
//                     liquidity >= this.config.minLiquidity &&
//                     trustScore >= this.config.minTrustScore,
//                 amount: this.calculatePositionSize(price, liquidity)
//             };
//         } catch (error) {
//             elizaLogger.error("Error evaluating token:", error);
//             return { shouldBuy: false, amount: 0 };
//         }
//     }

//     private async evaluatePosition(position: any): Promise<boolean> {
//         try {
//             const currentPrice = await this.tokenProvider.getPrice(position.tokenAddress);
//             const entryPrice = position.entryPrice;

//             const profitLoss = ((currentPrice - entryPrice) / entryPrice) * 100;

//             return profitLoss <= -this.config.stopLossPercent ||
//                    profitLoss >= this.config.targetProfitPercent;
//         } catch (error) {
//             elizaLogger.error("Error evaluating position:", error);
//             return false;
//         }
//     }

//     private async executeBuy(
//         tokenAddress: string,
//         amount: number,
//         runtime: IAgentRuntime
//     ): Promise<boolean> {
//         try {
//             const { publicKey } = await getWalletKey(runtime, false);
//             const quote = await this.getQuote(tokenAddress, amount);

//             if (quote.priceImpact <= this.config.maxSlippage) {
//                 return await this.executeSwap(
//                     tokenAddress,
//                     amount,
//                     publicKey
//                 );
//             }
//             return false;
//         } catch (error) {
//             elizaLogger.error("Error executing buy:", error);
//             return false;
//         }
//     }

//     private async executeSell(
//         tokenAddress: string,
//         amount: number,
//         runtime: IAgentRuntime
//     ): Promise<boolean> {
//         try {
//             const { publicKey } = await getWalletKey(runtime, false);
//             return await this.executeSwap(
//                 tokenAddress,
//                 amount,
//                 publicKey,
//                 true // isSell
//             );
//         } catch (error) {
//             elizaLogger.error("Error executing sell:", error);
//             return false;
//         }
//     }

//     private calculatePositionSize(price: number, liquidity: number): number {
//         // Implement position sizing logic based on risk management
//         const maxPositionSize = liquidity * 0.01; // 1% of liquidity
//         return Math.min(maxPositionSize, 1000); // Cap at 1000 USDC equivalent
//     }

//     // Original SwapProvider methods remain...
//     async get(
//         runtime: IAgentRuntime,
//         message: SwapMessage,
//         state?: State
//     ): Promise<any> {
//         // Existing implementation...
//     }

//     private async getQuote(
//         tokenAddress: string,
//         amount: number
//     ): Promise<any> {
//         // Existing implementation...
//     }

//     private async executeSwap(
//         tokenAddress: string,
//         amount: number,
//         publicKey: PublicKey,
//         isSell: boolean = false
//     ): Promise<boolean> {
//         // Existing implementation...
//     }
// }