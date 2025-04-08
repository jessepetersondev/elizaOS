import { elizaLogger, IAgentRuntime } from "@elizaos/core";
import fs from "fs";

/**
 * Sends a message to Discord using the runtime's existing discord client
 * @param message The text message to send
 * @param imagePath Optional path to an image file or URL to attach
 * @param channelId Discord channel ID to send the message to
 * @param runtime The agent runtime with the discord client
 * @returns Promise resolving to true if successful, false otherwise
 */
export async function sendDiscordMessage(
  message: string,
  imagePath: string = "",
  channelId: string,
  runtime: IAgentRuntime
): Promise<boolean> {
  try {
    // Check if Discord client is available in runtime
    elizaLogger.logColorfulForDiscord(`Runtime clients searching for discord: ${JSON.stringify(runtime.clients)}`);
    if (!runtime.clients?.discord) {
      elizaLogger.error("Discord client not available in runtime");
      return false;
    }

    // Validate the channel ID
    if (!channelId) {
      elizaLogger.error("Cannot send Discord message: Channel ID not provided");
      return false;
    }

    // Check if we have a valid image path or URL
    const isUrl = imagePath && (imagePath.startsWith('http://') || imagePath.startsWith('https://'));
    const isLocalFile = imagePath && fs.existsSync(imagePath);

    // Get the Discord channel using the client - avoid directly referencing discord.js types
    try {
      const discordClient = runtime.clients.discord;
      elizaLogger.logColorfulForDiscord(`Discord client: ${JSON.stringify(discordClient)}`);
      // Use a safe approach to send the message
      if (discordClient.client && typeof discordClient.client.channels?.fetch === 'function') {
        const channel = await discordClient.client.channels.fetch(channelId);

        if (!channel) {
          elizaLogger.error(`Discord channel not found: ${channelId}`);
          return false;
        }

        // Check if channel has a send method
        if (typeof (channel as any).send === 'function') {
          if (isLocalFile) {
            // If it's a local file, attach it directly
            await (channel as any).send({
              content: message,
              files: [imagePath]
            });
            elizaLogger.log(`Discord message with local image sent to channel ${channelId}`);
          } else if (isUrl) {
            // If it's a URL, use an embed with the image
            await (channel as any).send({
              content: message,
              embeds: [{
                image: {
                  url: imagePath
                }
              }]
            });
            elizaLogger.log(`Discord message with image URL embed sent to channel ${channelId}`);
          } else {
            // No valid image, just send the text
            await (channel as any).send({
              content: message
            });
            elizaLogger.log(`Discord message sent to channel ${channelId}`);
          }

          return true;
        } else {
          elizaLogger.error("Discord channel does not have a send method");
          return false;
        }
      } else {
        elizaLogger.error("Discord client does not have expected methods");
        return false;
      }
    } catch (channelError) {
      elizaLogger.error("Error with Discord channel operations:", channelError);
      return false;
    }
  } catch (error) {
    elizaLogger.error("Error sending Discord message:", error);
    return false;
  }
}
