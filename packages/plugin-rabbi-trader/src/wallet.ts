import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { decodeBase58 } from "./utils";
import { SAFETY_LIMITS } from "./constants";

interface BirdeyeTokenResponse {
    success: boolean;
    data: {
        address: string;
        symbol: string;
        decimals: number;
        price: number;
        volume24h: number;
        priceChange24h: number;
        liquidity: number;
        marketCap: number;
    }
}

interface BirdeyeTopTokenResponse {
    success: boolean;
    data: {
        items: Array<{
            address: string;
            volume: number;
            liquidity: number;
            price: number;
            priceChange24h: number;
            // ... other fields
        }>
    }
}
export async function getBirdeyeTokenData(tokenAddress: string, apiKey: string) {
    // Get basic token info
    const tokenResponse = await fetch(
        `https://public-api.birdeye.so/public/token?address=${tokenAddress}`,
        {
            headers: {
                'accept': 'application/json',
                'x-chain': 'solana',
                'X-API-KEY': apiKey
            }
        }
    );
    const tokenData: BirdeyeTokenResponse = await tokenResponse.json();

    // Get detailed market data
    const marketResponse = await fetch(
        `https://public-api.birdeye.so/public/token_list/top_tokens?address=${tokenAddress}`,
        {
            headers: {
                'accept': 'application/json',
                'x-chain': 'solana',
                'X-API-KEY': apiKey
            }
        }
    );
    const marketData: BirdeyeTopTokenResponse = await marketResponse.json();
    const tokenMarketData = marketData.data.items.find(item => item.address === tokenAddress);

    // Combine and map to DexScreener format
    return {
        pairs: [{
            chainId: "solana",
            dexId: "raydium",
            pairAddress: tokenAddress,
            url: `https://birdeye.so/token/${tokenAddress}`,
            fdv: tokenData.data.marketCap || 0,
            marketCap: tokenData.data.marketCap || 0,
            baseToken: {
                address: tokenAddress,
                name: tokenData.data.symbol,
                symbol: tokenData.data.symbol
            },
            quoteToken: {
                address: "So11111111111111111111111111111111111111112",
                name: "SOL",
                symbol: "SOL"
            },
            priceUsd: tokenData.data.price.toString(),
            priceChange: {
                h24: tokenData.data.priceChange24h,
                m5: 0
            },
            liquidity: {
                usd: tokenMarketData?.liquidity || tokenData.data.liquidity,
                base: 0,
                quote: 0
            },
            volume: {
                h24: tokenMarketData?.volume || tokenData.data.volume24h
            },
            txns: {
                h24: {
                    buys: 0,
                    sells: 0
                }
            }
        }]
    };
}


interface PriceDataPoint {
    address: string;
    unixTime: number;
    value: number;
}

interface PriceHistoryResponse {
    data: {
        items: PriceDataPoint[];
    };
    success: boolean;
}

export async function getTokenPriceHistoryFromBirdeye(tokenAddress: string, runtime: any): Promise<{
    currentPrice: number;
    priceChange1m: number;
    priceChange5m: number;
}> {
    const response = await fetch(
        `https://public-api.birdeye.so/defi/price_history?address=${tokenAddress}&type=1M`,
        {
            headers: {
                Accept: "application/json",
                "x-chain": "solana",
                "X-API-KEY": runtime.getSetting("BIRDEYE_API_KEY", "") || ""
            },
        }
    );

    const data: PriceHistoryResponse = await response.json();
    if (!data.success || !data.data.items.length) {
        throw new Error('Failed to fetch price history');
    }

    const prices = data.data.items;
    const currentPrice = prices[prices.length - 1].value;

    // Calculate 1m change
    const price1mAgo = prices[prices.length - 2]?.value;
    const priceChange1m = price1mAgo ? ((currentPrice - price1mAgo) / price1mAgo) * 100 : 0;

    // Calculate 5m change
    const price5mAgo = prices[prices.length - 6]?.value;
    const priceChange5m = price5mAgo ? ((currentPrice - price5mAgo) / price5mAgo) * 100 : 0;

    return {
        currentPrice,
        priceChange1m,
        priceChange5m
    };
}

/**
 * Gets wallet keypair from runtime settings
 * @param runtime Agent runtime environment
 * @returns Solana keypair for transactions
 * @throws Error if private key is missing or invalid
 */
export function getWalletKeypair(runtime?: IAgentRuntime): Keypair {
    // Check chain type from token address or configuration

    const privateKeyString = runtime?.getSetting("WALLET_PRIVATE_KEY");
    if (!privateKeyString) {
        throw new Error("No wallet private key configured");
    }

    try {
        const privateKeyBytes = decodeBase58(privateKeyString);
        return Keypair.fromSecretKey(privateKeyBytes);
    } catch (error) {
        elizaLogger.error("Failed to create wallet keypair:", error);
        throw error;
    }
}

/**
 * Gets current SOL balance for wallet
 * @param runtime Agent runtime environment
 * @returns Balance in SOL
 */
export async function getWalletBalance(
    runtime: IAgentRuntime
): Promise<number> {
    try {
        // Existing Solana balance logic
        const walletKeypair = getWalletKeypair(runtime);
        const walletPubKey = walletKeypair.publicKey;
        const connection = new Connection(
            runtime.getSetting("SOLANA_RPC_URL") ||
                "https://api.mainnet-beta.solana.com"
        );

        const balance = await connection.getBalance(walletPubKey);
        const solBalance = balance / 1e9;

        elizaLogger.log("Fetched Solana wallet balance:", {
            address: walletPubKey.toBase58(),
            lamports: balance,
            sol: solBalance,
        });

        return solBalance;
    } catch (error) {
        elizaLogger.error("Failed to get wallet balance:", error);
        return 0;
    }
}

const RPC_ENDPOINTS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
    "https://rpc.ankr.com/solana"
];
async function getConnection(runtime: IAgentRuntime): Promise<Connection> {
    // Try primary RPC first
    const primaryRPC = runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com"
    if (primaryRPC) {
        try {
            const connection = new Connection(primaryRPC, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000
            });
            await connection.getLatestBlockhash();
            return connection;
        } catch (error) {
            elizaLogger.warn("Primary RPC failed, trying fallbacks...");
        }
    }

    // Try fallback RPCs
    for (const rpc of RPC_ENDPOINTS) {
        try {
            const connection = new Connection(rpc, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000
            });
            await connection.getLatestBlockhash();
            return connection;
        } catch (error) {
            continue;
        }
    }

    throw new Error("All RPC endpoints failed");
}

// Add executeTrade function
export async function executeTrade(
    runtime: IAgentRuntime,
    params: {
        tokenAddress: string;
        amount: number;
        slippage: number;
        isSell?: boolean;
        chain?: "base" | "solana";
    },
    retryCount = 0
): Promise<any> {
    // Existing Solana trade logic remains unchanged
    try {
        elizaLogger.log(`[Trade Attempt ${retryCount + 1}] Starting execution:`, {
            tokenAddress: params.tokenAddress,
            isSell: params.isSell,
            amount: params.amount,
            retryCount
        });
        elizaLogger.log("Executing Solana trade with params:", params);

        const SOL_ADDRESS = "So11111111111111111111111111111111111111112";

        if (!params.isSell && params.amount < SAFETY_LIMITS.MINIMUM_TRADE) {
            elizaLogger.warn("Trade amount too small:", {
                amount: params.amount,
                minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
            });
            return {
                success: false,
                error: "Trade amount too small",
                details: {
                    amount: params.amount,
                    minimumRequired: SAFETY_LIMITS.MINIMUM_TRADE,
                },
            };
        }

        const walletKeypair = getWalletKeypair(runtime);
        const connection = await getConnection(runtime);

        // Setup swap parameters
        const inputTokenCA = params.isSell ? params.tokenAddress : SOL_ADDRESS;
        const outputTokenCA = params.isSell ? SOL_ADDRESS : params.tokenAddress;
        const swapAmount = Math.floor(params.amount * 1e9);

        elizaLogger.log("Trade execution details:", {
            isSell: params.isSell,
            inputToken: inputTokenCA,
            outputToken: outputTokenCA,
            amount: params.amount,
            slippage: params.slippage,
        });

        // Get quote
        const quoteResponse = await fetch(
            `https://quote-api.jup.ag/v6/quote?inputMint=${inputTokenCA}&outputMint=${outputTokenCA}&amount=${swapAmount}&slippageBps=${Math.floor(params.slippage * 10000)}`
        );

        if (!quoteResponse.ok) {
            const error = await quoteResponse.text();
            elizaLogger.warn("Quote request failed:", {
                status: quoteResponse.status,
                error,
            });
            return {
                success: false,
                error: "Failed to get quote",
                details: { status: quoteResponse.status, error },
            };
        }

        const quoteData = await quoteResponse.json();
        if (!quoteData || quoteData.error) {
            elizaLogger.warn("Invalid quote data:", quoteData);
            return {
                success: false,
                error: "Invalid quote data",
                details: quoteData,
            };
        }

        elizaLogger.log("Quote received:", quoteData);

        // Get swap transaction
        const swapResponse = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                quoteResponse: quoteData,
                userPublicKey: walletKeypair.publicKey.toString(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 2000000,
                dynamicComputeUnitLimit: true,
            }),
        });

        const swapData = await swapResponse.json();
        if (!swapData?.swapTransaction) {
            throw new Error("No swap transaction returned");
        }

        elizaLogger.log("Swap transaction received");

        // Deserialize transaction
        const transactionBuf = Buffer.from(swapData.swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(transactionBuf);

        // Get fresh blockhash and sign transaction
        const { blockhash, lastValidBlockHeight } =
            await connection.getLatestBlockhash("finalized");
        tx.message.recentBlockhash = blockhash;
        tx.sign([walletKeypair]);

        // Send with confirmation using more lenient settings
        const signature = await connection.sendTransaction(tx, {
            skipPreflight: false,
            maxRetries: 5,
            preflightCommitment: "processed",
        });

        elizaLogger.log("Transaction sent:", signature);

        // Wait for confirmation with more lenient settings
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                blockhash,
                lastValidBlockHeight,
            },
            "processed"
        ); // Use 'processed' instead of default 'finalized'

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        // Add additional verification
        const status = await connection.getSignatureStatus(signature);
        if (status.value?.err) {
            throw new Error(
                `Transaction verification failed: ${status.value.err}`
            );
        }

        elizaLogger.log("Solana trade executed successfully:", {
            signature,
            explorer: `https://solscan.io/tx/${signature}`,
        });

        // After successful confirmation
        elizaLogger.log(`[Trade Attempt ${retryCount + 1}] Transaction confirmed:`, {
            signature,
            tokenAddress: params.tokenAddress,
            isSell: params.isSell,
            confirmation: confirmation.value,
            status: status.value
        });

        return {
            success: true,
            signature,
            confirmation,
            explorer: `https://solscan.io/tx/${signature}`,
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        elizaLogger.error(`[Trade Attempt ${retryCount + 1}] Execution failed:`, {
            tokenAddress: params.tokenAddress,
            isSell: params.isSell,
            errorType: error.constructor.name,
            errorMessage,
            retryCount,
            params: {
                amount: params.amount,
                slippage: params.slippage
            }
        });

        // Handle blockhash errors with retry and longer timeout
        if (
            (errorMessage.includes("Blockhash not found") ||
             errorMessage.includes("block height exceeded")) &&
            retryCount < 3
        ) {
            elizaLogger.warn(
                `[Trade Attempt ${retryCount + 1}/3] Retrying blockhash error:`, {
                    tokenAddress: params.tokenAddress,
                    isSell: params.isSell,
                    nextAttempt: retryCount + 2,
                    errorMessage,
                    delayMs: 5000
                }
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
            return executeTrade(runtime, params, retryCount + 1);
        }

        // Log non-retryable errors
        elizaLogger.error(`[Trade Attempt ${retryCount + 1}] Final failure:`, {
            tokenAddress: params.tokenAddress,
            isSell: params.isSell,
            errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
            retryCount,
            isRetryable: false
        });

        return {
            success: false,
            error: errorMessage,
            attempt: retryCount + 1,
            params: {
                tokenAddress: params.tokenAddress,
                isSell: params.isSell,
                amount: params.amount
            },
            stack: error instanceof Error ? error.stack : undefined
        };
    }
}

export async function getChainWalletBalance(
    runtime: IAgentRuntime,
    tokenAddress: string
): Promise<number> {
    // Get Solana balance
    return await getWalletBalance(runtime);
}

// Add this helper function at the top level
export async function simulateTransaction(
    client: any,
    tx: any
): Promise<string> {
    try {
        const result = await client.call({
            account: client.account,
            to: tx.to,
            data: tx.data,
            value: tx.value,
            gas: tx.gas,
            gasPrice: tx.gasPrice,
        });
        return result;
    } catch (error) {
        return `Simulation failed: ${error.message}`;
    }
}
