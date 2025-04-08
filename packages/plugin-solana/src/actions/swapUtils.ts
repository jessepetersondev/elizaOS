import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
    type BlockhashWithExpiryBlockHeight,
    Connection,
    type Keypair,
    PublicKey,
    type RpcResponseAndContext,
    type SimulatedTransactionResponse,
    type TokenAmount,
    VersionedTransaction,
} from "@solana/web3.js";
import { settings, elizaLogger } from "@elizaos/core";
import { IAgentRuntime } from "@elizaos/core";
import { validateSolanaConfig } from "../environment";


const solAddress = settings.SOL_ADDRESS;
const SLIPPAGE = settings.SLIPPAGE;
const connection = new Connection(
    settings.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"
);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Executes a function only if auto-trading is enabled
 * @param runtime The agent runtime
 * @param action The action to execute if auto-trading is enabled
 * @returns The result of the action, or a message if auto-trading is disabled
 */
export async function executeWithAutoTrading<T>(
    runtime: IAgentRuntime,
    action: () => Promise<T>
): Promise<T | { text: string }> {
    try {
        const config = await validateSolanaConfig(runtime);

        if (!config.ENABLE_AUTO_TRADING) {
            return {
                text: "Auto-trading is currently disabled. Please enable it in the configuration.",
            };
        }

        // Execute the action with error handling
        try {
            return await action();
        } catch (error) {
            console.error("Error executing auto-trading action:", error);
            return {
                text: "An error occurred while executing the auto-trading action. Please check the logs for more details.",
            };
        }
    } catch (error) {
        console.error("Error validating Solana config:", error);
        return {
            text: "Failed to validate Solana configuration. Please check your settings.",
        };
    }
}


export async function delayedCall<T>(
    method: (...args: any[]) => Promise<T>,
    ...args: any[]
): Promise<T> {
    await delay(150);
    return method(...args);
}

export async function getTokenDecimals(
    connection: Connection,
    mintAddress: string
): Promise<number> {
    const mintPublicKey = new PublicKey(mintAddress);
    const tokenAccountInfo =
        await connection.getParsedAccountInfo(mintPublicKey);

    // Check if the data is parsed and contains the expected structure
    if (
        tokenAccountInfo.value &&
        typeof tokenAccountInfo.value.data === "object" &&
        "parsed" in tokenAccountInfo.value.data
    ) {
        const parsedInfo = tokenAccountInfo.value.data.parsed?.info;
        if (parsedInfo && typeof parsedInfo.decimals === "number") {
            return parsedInfo.decimals;
        }
    }

    throw new Error("Unable to fetch token decimals");
}

export async function getQuote(
    connection: Connection,
    baseToken: string,
    outputToken: string,
    amount: number
): Promise<any> {
    const decimals = await getTokenDecimals(connection, baseToken);
    const adjustedAmount = amount * 10 ** decimals;

    const quoteResponse = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${baseToken}&outputMint=${outputToken}&amount=${adjustedAmount}&slippageBps=50`
    );
    const swapTransaction = await quoteResponse.json();
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    return new Uint8Array(swapTransactionBuf);
}

export const executeSwap = async (
    transaction: VersionedTransaction,
    type: "buy" | "sell"
) => {
    try {
        const latestBlockhash: BlockhashWithExpiryBlockHeight =
            await delayedCall(connection.getLatestBlockhash.bind(connection));
        const signature = await connection.sendTransaction(transaction, {
            skipPreflight: false,
        });
        const confirmation = await connection.confirmTransaction(
            {
                signature,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                blockhash: latestBlockhash.blockhash,
            },
            "confirmed"
        );
        if (confirmation.value.err) {
            elizaLogger.log("Confirmation error", confirmation.value.err);

            throw new Error("Confirmation error");
        } else {
            if (type === "buy") {
                elizaLogger.log(
                    "Buy successful: https://solscan.io/tx/${signature}"
                );
            } else {
                elizaLogger.log(
                    "Sell successful: https://solscan.io/tx/${signature}"
                );
            }
        }

        return signature;
    } catch (error) {
        elizaLogger.log(error);
    }
};

export const Sell = async (baseMint: PublicKey, wallet: Keypair) => {
    try {
        const tokenAta = await delayedCall(
            getAssociatedTokenAddress,
            baseMint,
            wallet.publicKey
        );
        const tokenBalInfo: RpcResponseAndContext<TokenAmount> =
            await delayedCall(
                connection.getTokenAccountBalance.bind(connection),
                tokenAta
            );

        if (!tokenBalInfo) {
            elizaLogger.log("Balance incorrect");
            return null;
        }

        const tokenBalance = tokenBalInfo.value.amount;
        if (tokenBalance === "0") {
            elizaLogger.warn(
                `No token balance to sell with wallet ${wallet.publicKey}`
            );
        }

        const sellTransaction = await getSwapTxWithWithJupiter(
            wallet,
            baseMint,
            tokenBalance,
            "sell"
        );

        if (!sellTransaction) {
            elizaLogger.log("Failed to get sell transaction");
            return null;
        }

        // const simulateResult: RpcResponseAndContext<SimulatedTransactionResponse> =
        //     await delayedCall(
        //         connection.simulateTransaction.bind(connection),
        //         sellTransaction
        //     );
        // if (simulateResult.value.err) {
        //     elizaLogger.log("Sell Simulation failed", simulateResult.value.err);
        //     return null;
        // }

        // execute the transaction
        return executeSwap(sellTransaction, "sell");
    } catch (error) {
        elizaLogger.log(error);
    }
};

export const Buy = async (baseMint: PublicKey, wallet: Keypair) => {
    try {
        const tokenAta = await delayedCall(
            getAssociatedTokenAddress,
            baseMint,
            wallet.publicKey
        );
        const tokenBalInfo: RpcResponseAndContext<TokenAmount> =
            await delayedCall(
                connection.getTokenAccountBalance.bind(connection),
                tokenAta
            );

        if (!tokenBalInfo) {
            elizaLogger.log("Balance incorrect");
            return null;
        }

        const tokenBalance = tokenBalInfo.value.amount;
        if (tokenBalance === "0") {
            elizaLogger.warn(
                `No token balance to sell with wallet ${wallet.publicKey}`
            );
        }

        const buyTransaction = await getSwapTxWithWithJupiter(
            wallet,
            baseMint,
            tokenBalance,
            "buy"
        );
        // simulate the transaction
        if (!buyTransaction) {
            elizaLogger.log("Failed to get buy transaction");
            return null;
        }

        const simulateResult: RpcResponseAndContext<SimulatedTransactionResponse> =
            await delayedCall(
                connection.simulateTransaction.bind(connection),
                buyTransaction
            );
        if (simulateResult.value.err) {
            elizaLogger.log("Buy Simulation failed", simulateResult.value.err);
            return null;
        }

        // execute the transaction
        return executeSwap(buyTransaction, "buy");
    } catch (error) {
        elizaLogger.log(error);
    }
};

export const getSwapTxWithWithJupiter = async (
    wallet: Keypair,
    baseMint: PublicKey,
    amount: string,
    type: "buy" | "sell"
) => {
    try {
        switch (type) {
            case "buy":
                return fetchBuyTransaction(wallet, baseMint, amount);
            case "sell":
                return fetchSellTransaction(wallet, baseMint, amount);
            default:
                return fetchSellTransaction(wallet, baseMint, amount);
        }
    } catch (error) {
        elizaLogger.log(error);
    }
};

export const fetchBuyTransaction = async (
    wallet: Keypair,
    baseMint: PublicKey,
    amount: string
) => {
    try {
        const quoteResponse = await (
            await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=${solAddress}&outputMint=${baseMint.toBase58()}&amount=${amount}&slippageBps=${SLIPPAGE}`
            )
        ).json();
        const { swapTransaction } = await (
            await fetch("https://quote-api.jup.ag/v6/swap", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 100000,
                }),
            })
        ).json();
        if (!swapTransaction) {
            elizaLogger.log("Failed to get buy transaction");
            return null;
        }

        // deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
        const transaction =
            VersionedTransaction.deserialize(swapTransactionBuf);

        // sign the transaction
        transaction.sign([wallet]);
        return transaction;
    } catch (error) {
        elizaLogger.log("Failed to get buy transaction", error);
        return null;
    }
};

export const fetchSellTransaction = async (
    wallet: Keypair,
    baseMint: PublicKey,
    amount: string
) => {
    try {
        const quoteResponse = await (
            await fetch(
                `https://quote-api.jup.ag/v6/quote?inputMint=${baseMint.toBase58()}&outputMint=${solAddress}&amount=${amount}&slippageBps=${SLIPPAGE}`
            )
        ).json();

        // get serialized transactions for the swap
        const { swapTransaction } = await (
            await fetch("https://quote-api.jup.ag/v6/swap", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: 52000,
                }),
            })
        ).json();
        if (!swapTransaction) {
            elizaLogger.log("Failed to get sell transaction");
            return null;
        }

        // deserialize the transaction
        const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
        const transaction =
            VersionedTransaction.deserialize(swapTransactionBuf);

        // sign the transaction
        transaction.sign([wallet]);
        return transaction;
    } catch (error) {
        elizaLogger.log("Failed to get sell transaction", error);
        return null;
    }
};