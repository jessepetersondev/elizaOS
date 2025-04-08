import { Connection, PublicKey } from "@solana/web3.js";
import { type IAgentRuntime, elizaLogger } from "@elizaos/core";
import { SwapMessage, SwapProvider } from "./swap";
import { TokenProvider } from "./token";
import { getWalletKey } from "../keypairUtils";
import { WalletProvider } from "./wallet";
import { ProcessedTokenData } from "../types/token";
import { v4 as uuidv4 } from 'uuid';

interface TradeDetails {
    userId: string;
    ticker: string;
    contractAddress: string;
    timestamp: string;
    amount: number;
    price: number;
}

export class RealTradingService {
    private connection: Connection;
    private swapProvider: SwapProvider;
    private tokenProvider: TokenProvider;
    private walletProvider: WalletProvider;
    private baseMint: PublicKey;
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
        this.connection = new Connection(runtime.getSetting("SOLANA_RPC_URL"));
        this.swapProvider = new SwapProvider(this.connection);

        // Initialize wallet provider
        const publicKey = new PublicKey(runtime.getSetting("MAIN_WALLET_ADDRESS"));
        this.walletProvider = new WalletProvider(this.connection, publicKey);

        // Initialize token provider with required parameters
        this.tokenProvider = new TokenProvider(
            "", // tokenAddress will be set during execution
            this.walletProvider,
            runtime.cacheManager
        );

        this.baseMint = new PublicKey(
            runtime.getSetting("BASE_MINT") ||
            "So11111111111111111111111111111111111111112"
        );
    }

    async executeSell(
        tokenAddress: string,
        amount: number,
        recommenderId: string | null
    ): Promise<boolean> {
        try {
            // 1. Get processed token data for validation
            this.tokenProvider = new TokenProvider(
                tokenAddress,
                this.walletProvider,
                this.runtime.cacheManager
            );
            const tokenData: ProcessedTokenData = await this.tokenProvider.getProcessedTokenData();

            if (!tokenData) {
                throw new Error("Invalid token or unable to fetch token data");
            }

            // 2. Get wallet
            const { publicKey, keypair } = await getWalletKey(this.runtime, false);

            // 3. Record trade in order book
            const tradeDetails: TradeDetails = {
                userId: recommenderId || "system",
                ticker: tokenData.tokenCodex.symbol || tokenAddress,
                contractAddress: tokenAddress,
                timestamp: new Date().toISOString(),
                amount: amount,
                price: tokenData.tradeData.price || 0
            };

            // Save to cache
            const orderBookPath = this.runtime.getSetting("orderBookPath") ?? "solana/orderBook";
            const existingOrders = await this.runtime.cacheManager.get<TradeDetails[]>(orderBookPath) || [];
            existingOrders.push(tradeDetails);
            await this.runtime.cacheManager.set(orderBookPath, existingOrders);

            // 4. Execute actual swap
            const userId = this.formatUUID(recommenderId || uuidv4());
            const agentId = this.formatUUID(this.runtime.agentId || uuidv4());
            const roomId = this.formatUUID(this.runtime.getSetting("ROOM_ID") || uuidv4());

            const swapMessage: SwapMessage = {
                tokenInAddress: tokenAddress,
                tokenOutAddress: this.baseMint.toBase58(),
                amount: amount,
                userId,
                agentId,
                content: {
                    type: "swap",
                    text: `Swap ${amount} ${tokenAddress} for ${this.baseMint.toBase58()}`,
                    data: {
                        tokenInAddress: tokenAddress,
                        tokenOutAddress: this.baseMint.toBase58(),
                        amount: amount
                    }
                },
                roomId
            };
            const result = await this.swapProvider.get(this.runtime, swapMessage);

            if (!result.executed) {
                throw new Error("Swap execution failed");
            }

            return true;
        } catch (error) {
            elizaLogger.error("Error executing sell:", error);
            return false;
        }
    }

    formatUUID(id: string) {
        const uuid = id || uuidv4();
        const [s1, s2, s3, s4, s5] = uuid.split('-');
        return `${s1}-${s2}-${s3}-${s4}-${s5}` as const;
    }
}