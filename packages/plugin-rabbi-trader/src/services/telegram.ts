import { elizaLogger } from "@elizaos/core";
import { Telegraf } from 'telegraf';
import { MarketData } from "../types";
import { z } from "zod";
import { TwitterConfigSchema } from "./twitter";

export const TelegramConfigSchema = z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
});

export interface TelegramConfig {
    TELEGRAM_BOT_TOKEN: string;
}
export interface TradeBuyAlert {
  token: string;
  tokenAddress: string;
  amount: number;
  trustScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  marketData: MarketData;
  timestamp: number;
  signature?: string;
  hash?: string;
  explorerUrl?: string;
  action?: "BUY" | "SELL" | "WAIT" | "SKIP";
  reason?: string;
  price?: number;
  profitPercent?: string;
  profitUsd?: string;
}

// Set up trade notification function
export const sendTelegramMessage = async (
  telegramService: TelegramService,
  alert: TradeBuyAlert,
) => {
  if (telegramService) {
    await telegramService.sendTelegramMessage({
      ...alert,
      timestamp: Date.now(),
    });
  }
};

export class TelegramService {
    private client: any;
    private config: z.infer<typeof TelegramConfigSchema>;

    constructor(client: any, config: z.infer<typeof TelegramConfigSchema>) {
        //this.bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);
        this.client = client;
        this.config = config;
    }
    async sendMessage(message: string) {
        try {
            await this.client.telegramClient.sendMessage(this.client, message, {
                parse_mode: 'Markdown'
            });

            elizaLogger.log(`Telegram message sent: ${message.substring(0, 30)}...`);
        } catch (error) {
            elizaLogger.error('Error sending Telegram message:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
        }
    }
    async sendTelegramMessage(alert: TradeBuyAlert) {
        try {
            const formatNumber = (num: number) =>
                new Intl.NumberFormat('en-US', {
                    maximumFractionDigits: 2
                }).format(num);

            let message = `🤖 Rabbi Trader ${alert.action || 'UPDATE'}\n\n`;
            message += `Token: ${alert.token}\n`;
            message += `Address: \`${alert.tokenAddress}\`\n`;

            if (alert.price) {
                message += `Price: $${alert.price.toFixed(8)}\n`;
            }

            message += `Amount: ${formatNumber(alert.amount)} SOL\n`;
            message += `Trust Score: ${(alert.trustScore * 100).toFixed(1)}%\n`;
            message += `Risk Level: ${alert.riskLevel}\n\n`;

            message += `📊 Market Data (24h):\n`;
            message += `Price Change: ${formatNumber(alert.marketData.priceChange24h)}%\n`;
            message += `Volume: $${formatNumber(alert.marketData.volume24h)}\n`;
            message += `Liquidity: $${formatNumber(alert.marketData.liquidity.usd)}\n`;

            if (alert.action === "SELL" && alert.profitPercent && alert.profitUsd) {
                message += `\n💰 Trade Result:\n`;
                message += `Profit: ${alert.profitPercent}\n`;
                message += `USD Value: ${alert.profitUsd}\n`;
                if (alert.reason) {
                    message += `Reason: ${alert.reason}\n`;
                }
            }

            if (alert.explorerUrl) {
                message += `\n🔍 Explorer: ${alert.explorerUrl}`;
            } else {
                message += `\n🔍 Explorer: https://solscan.io/token/${alert.tokenAddress}`;
            }

            await this.client.telegramClient.sendMessage(this.client, message, {
                parse_mode: 'Markdown'
            });

            elizaLogger.log(`Telegram message sent for ${alert.action || 'UPDATE'} ${alert.token}`);
        } catch (error) {
            elizaLogger.error('Error sending Telegram message:', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
        }
    }
}