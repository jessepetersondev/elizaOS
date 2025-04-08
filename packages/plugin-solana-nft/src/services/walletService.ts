import { Connection, Keypair, PublicKey, clusterApiUrl } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IAgentRuntime, elizaLogger } from '@elizaos/core';
import { PluginSolanaNFTSettings } from '../types';

/**
 * Service for managing Solana wallets
 */
export class WalletService {
  private connection: Connection;
  private walletPath: string;
  private network: string;

  constructor(private runtime: IAgentRuntime, private settings: PluginSolanaNFTSettings) {
    this.network = settings.network || 'devnet';
    this.connection = new Connection(
      this.network === 'localnet' ? 'http://localhost:8899' : clusterApiUrl(this.network as any)
    );

    this.walletPath = settings.walletPath || path.join(process.cwd(), '.solana', 'wallets');

    // Ensure wallet directory exists
    if (!fs.existsSync(this.walletPath)) {
      fs.mkdirSync(this.walletPath, { recursive: true });
    }
  }

  /**
   * Gets the connection to the Solana network
   */
  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Gets the wallet keypair from a wallet name or key
   * @param walletName - The name of the wallet or base58 encoded private key
   */
  async getWallet(walletName: string): Promise<Keypair> {
    try {
      // Check if wallet name is actually a base58 private key
      if (walletName.length > 64) {
        // It's likely a base58 encoded private key
        const decodedKey = new Uint8Array(Buffer.from(walletName, 'base64'));
        return Keypair.fromSecretKey(decodedKey);
      }

      // Check if it's a stored wallet
      const walletFilePath = path.join(this.walletPath, `${walletName}.json`);

      if (fs.existsSync(walletFilePath)) {
        const walletData = fs.readFileSync(walletFilePath, 'utf-8');
        const secretKey = new Uint8Array(JSON.parse(walletData));
        return Keypair.fromSecretKey(secretKey);
      }

      // If not found, check if it's a setting in the runtime
      const privateKeyString = this.runtime.getSetting(`SOLANA_${walletName.toUpperCase()}_PRIVATE_KEY`);
      if (privateKeyString) {
        return Keypair.fromSecretKey(
          new Uint8Array(JSON.parse(privateKeyString))
        );
      }

      // If we get here and still no wallet, check for a generic SOLANA_PRIVATE_KEY
      const genericPrivateKey = this.runtime.getSetting('SOLANA_PRIVATE_KEY');
      if (genericPrivateKey) {
        return Keypair.fromSecretKey(
          new Uint8Array(JSON.parse(genericPrivateKey))
        );
      }

      // If still no wallet, generate a new one
      elizaLogger.info(`Wallet "${walletName}" not found, generating a new one...`);
      return this.createWallet(walletName);
    } catch (error) {
      elizaLogger.error('Error getting wallet:', error);
      throw new Error(`Failed to get wallet: ${error.message}`);
    }
  }

  /**
   * Creates a new wallet and saves it
   * @param walletName - The name to give the wallet
   */
  async createWallet(walletName: string): Promise<Keypair> {
    const newWallet = Keypair.generate();
    const walletFilePath = path.join(this.walletPath, `${walletName}.json`);

    fs.writeFileSync(
      walletFilePath,
      JSON.stringify(Array.from(newWallet.secretKey)),
      'utf-8'
    );

    elizaLogger.info(`Created new wallet "${walletName}" with public key: ${newWallet.publicKey.toString()}`);
    return newWallet;
  }

  /**
   * Gets the balance for a wallet
   * @param walletOrAddress - The wallet keypair or address
   */
  async getBalance(walletOrAddress: Keypair | string): Promise<number> {
    try {
      const publicKey = typeof walletOrAddress === 'string'
        ? new PublicKey(walletOrAddress)
        : walletOrAddress.publicKey;

      const balance = await this.connection.getBalance(publicKey);
      return balance / 1000000000; // Convert lamports to SOL
    } catch (error) {
      elizaLogger.error('Error getting balance:', error);
      throw new Error(`Failed to get balance: ${error.message}`);
    }
  }

  /**
   * Airdrops SOL to a wallet (only works on devnet and testnet)
   * @param walletOrAddress - The wallet keypair or address
   * @param amount - Amount of SOL to airdrop (up to 2 on devnet)
   */
  async requestAirdrop(walletOrAddress: Keypair | string, amount: number = 1): Promise<string> {
    try {
      if (this.network === 'mainnet-beta') {
        throw new Error('Airdrop not available on mainnet');
      }

      const publicKey = typeof walletOrAddress === 'string'
        ? new PublicKey(walletOrAddress)
        : walletOrAddress.publicKey;

      const signature = await this.connection.requestAirdrop(
        publicKey,
        amount * 1000000000 // Convert SOL to lamports
      );

      await this.connection.confirmTransaction(signature);
      elizaLogger.info(`Airdropped ${amount} SOL to ${publicKey.toString()}`);
      return signature;
    } catch (error) {
      elizaLogger.error('Error requesting airdrop:', error);
      throw new Error(`Failed to request airdrop: ${error.message}`);
    }
  }
}