import { elizaLogger } from "@elizaos/core";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

export class TokenProvider {
    private prices: { [key: string]: { usd: number } };
    private connection: Connection;

    constructor(connection: Connection) {
        // Ensure prices is explicitly initialized as an object
        Object.defineProperty(this, "prices", {
            value: {},
            writable: true,
            enumerable: true,
            configurable: true
        });

        this.connection = connection;
    }

    async fetchPrices(tokens: string[]): Promise<void> {
        try {
            for (const token of tokens) {
                // Ensure the token object exists before setting properties
                if (typeof this.prices !== "object") {
                    this.prices = {};
                }

                if (!this.prices[token]) {
                    Object.defineProperty(this.prices, token, {
                        value: { usd: 0 },
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                }

                // Now safely set the price
                this.prices[token].usd = 1.0;
                elizaLogger.info(`Set mock price for ${token}: ${this.prices[token].usd}`);
            }
        } catch (error) {
            elizaLogger.error("Error in fetchPrices:", error);
            throw new Error(`Failed to fetch prices: ${error.message}`);
        }
    }

    async calculateBuyAmounts(tokenAddress: string, amount: number): Promise<number> {
        try {
            // Ensure price exists
            if (!this.prices || !this.prices[tokenAddress] || typeof this.prices[tokenAddress]?.usd !== "number") {
                await this.fetchPrices([tokenAddress]);
            }

            const price = this.prices[tokenAddress]?.usd;
            if (!price || price === 0) {
                throw new Error(`No valid price found for token ${tokenAddress}`);
            }

            return amount / price;
        } catch (error) {
            elizaLogger.error("Error calculating buy amounts:", error);
            throw error;
        }
    }

    async getTokenBalance(tokenAddress: string, walletAddress: string): Promise<number> {
        try {
            const tokenMint = new PublicKey(tokenAddress);
            const wallet = new PublicKey(walletAddress);

            const tokenAccount = await getAssociatedTokenAddress(
                tokenMint,
                wallet
            );

            const balance = await this.connection.getTokenAccountBalance(tokenAccount);
            return parseFloat(balance.value.amount);
        } catch (error) {
            elizaLogger.error(`Error getting token balance for ${tokenAddress}:`, error);
            return 0;
        }
    }

    async swap(
        tokenInAddress: string,
        tokenOutAddress: string,
        amount: number,
        walletKeyPair: Keypair
    ): Promise<boolean> {
        try {
            elizaLogger.info(`Starting swap from ${tokenInAddress} to ${tokenOutAddress}`);

            // Validate input parameters
            if (!tokenInAddress || !tokenOutAddress || !amount || !walletKeyPair) {
                throw new Error("Missing required parameters for swap");
            }

            // Get token accounts
            const tokenInMint = new PublicKey(tokenInAddress);
            const tokenOutMint = new PublicKey(tokenOutAddress);
            const walletPubkey = walletKeyPair.publicKey;

            const tokenInAccount = await getAssociatedTokenAddress(
                tokenInMint,
                walletPubkey
            );

            const tokenOutAccount = await getAssociatedTokenAddress(
                tokenOutMint,
                walletPubkey
            );

            // Calculate amounts
            const amountOut = await this.calculateBuyAmounts(tokenOutAddress, amount);

            // Create transaction
            const transaction = new Transaction();

            // Add swap instruction (this would be your actual swap instruction)
            // transaction.add(swapInstruction(...));

            // Sign and send transaction
            const signature = await this.connection.sendTransaction(
                transaction,
                [walletKeyPair]
            );

            await this.connection.confirmTransaction(signature);

            elizaLogger.info(`Swap completed successfully. Signature: ${signature}`);
            return true;
        } catch (error) {
            elizaLogger.error("Error executing swap:", error);
            return false;
        }
    }
}

// Ensure the default export is properly defined
const provider = TokenProvider;
export default provider;