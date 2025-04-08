# ElizaOS Solana NFT Plugin

A plugin for ElizaOS that provides functionality for creating and managing NFTs on the Solana blockchain.

## Features

- Create NFTs on Solana with custom metadata
- Fetch NFT information by mint address
- Get all NFTs owned by a wallet address
- Support for different Solana networks (mainnet, devnet, testnet)

## Installation

```bash
# From your ElizaOS project root
npm install @elizaos/plugin-solana-nft
```

## Configuration

Add the plugin to your ElizaOS configuration:

```typescript
import { PluginSolanaNFT } from '@elizaos/plugin-solana-nft';

// Initialize the agent with the plugin
const agent = new Agent({
  plugins: [
    new PluginSolanaNFT()
  ],
  settings: {
    'solana-nft': {
      network: 'devnet', // or 'mainnet-beta', 'testnet', 'localnet'
      walletPath: './.solana/wallets', // Optional path to wallet directory
    }
  }
});

await agent.init();
```

## Usage

### Creating an NFT

```typescript
const nftData = await agent.performAction('createNFT', {
  wallet: 'myWallet', // Wallet name or base58 encoded private key
  metadata: {
    name: 'My First NFT',
    symbol: 'NFT',
    description: 'An amazing NFT created with ElizaOS Solana NFT Plugin',
    attributes: [
      {
        trait_type: 'Color',
        value: 'Blue'
      }
    ]
  },
  isMutable: true // Whether the NFT metadata can be updated later
});

console.log('NFT created with mint address:', nftData.mint);
```

### Getting NFT Information

```typescript
const nft = await agent.performAction('getNFT', {
  mintAddress: 'MINT_ADDRESS_HERE'
});

console.log('NFT Metadata:', nft.metadata);
```

### Getting NFTs Owned by a Wallet

```typescript
const nfts = await agent.performAction('getUserNFTs', {
  walletAddress: 'WALLET_ADDRESS_HERE'
});

console.log('User owns', nfts.length, 'NFTs');
```

## Solana Networks

The plugin supports the following Solana networks:

- `mainnet-beta`: Solana mainnet
- `devnet`: Solana devnet (default)
- `testnet`: Solana testnet
- `localnet`: Local Solana network (http://localhost:8899)

## Wallet Management

The plugin can work with wallets in several ways:

1. **Stored wallets**: Wallets stored in the configured wallet directory
2. **Environment variables**: Private keys stored in environment variables (SOLANA_PRIVATE_KEY)
3. **Direct private keys**: Base58 encoded private keys passed directly to actions

## License

MIT