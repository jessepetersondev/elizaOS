import { Connection, PublicKey } from "@solana/web3.js";
import { IAgentRuntime } from "@elizaos/core";
import type { Signature, WalletClient } from "@goat-sdk/core";

// Extended Balance interface to include formatted
export interface ExtendedBalance {
    formatted: string;
    // Add these properties to make it compatible with WalletClient's Balance
    decimals: number;
    symbol: string;
    name: string;
    value: bigint;
}

// Centralized wallet provider interface
export interface ExtendedWalletProvider extends WalletClient {
    connection: Connection;
    // Override methods to match our requirements
    signMessage(message: string): Promise<Signature>;
    getFormattedPortfolio: (runtime: IAgentRuntime) => Promise<string>;
    balanceOf(tokenAddress: string): Promise<ExtendedBalance>;
    getMaxBuyAmount: (tokenAddress: string) => Promise<number>;
    executeTrade: (params: {
        tokenIn: string;
        tokenOut: string;
        amountIn: number;
        slippage: number;
    }) => Promise<any>;
}