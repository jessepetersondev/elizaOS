import { IAgentRuntime, UUID, Memory } from '@elizaos/core';
import { elizaLogger } from "@elizaos/core";
import { v4 as uuidv4 } from 'uuid';

export class AIDecisionService {
    private runtime: IAgentRuntime;

    constructor(runtime: IAgentRuntime) {
        this.runtime = runtime;
    }

    async analyzeSentiment(topic: string): Promise<{score: number; analysis: string}> {
        try {
            const result = await this.promptAgent(`Analyze the current market sentiment for ${topic}. Provide a sentiment score from -100 (extremely negative) to +100 (extremely positive) and explain your reasoning.`);

            // Parse the response to extract sentiment score
            const scoreMatch = result.match(/score:?\s*([-+]?\d+)/i);
            const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;

            return {
                score,
                analysis: result
            };
        } catch (error) {
            elizaLogger.error(`Error analyzing sentiment for ${topic}:`, error);
            return { score: 0, analysis: "Error analyzing sentiment" };
        }
    }

    async predictPriceMovement(asset: string, timeframe: string): Promise<{direction: string; confidence: number; reasoning: string}> {
        try {
            const result = await this.promptAgent(`Predict the price movement for ${asset} over the next ${timeframe}. Specify direction (UP/DOWN/SIDEWAYS), confidence level (0-100%), and explain your reasoning.`);

            // Parse the response
            const directionMatch = result.match(/direction:?\s*(UP|DOWN|SIDEWAYS)/i);
            const confidenceMatch = result.match(/confidence:?\s*(\d+)/i);

            return {
                direction: directionMatch ? directionMatch[1].toUpperCase() : "SIDEWAYS",
                confidence: confidenceMatch ? parseInt(confidenceMatch[1]) : 50,
                reasoning: result
            };
        } catch (error) {
            elizaLogger.error(`Error predicting price movement for ${asset}:`, error);
            return { direction: "SIDEWAYS", confidence: 0, reasoning: "Error predicting price movement" };
        }
    }

    async generateTradingStrategy(asset: string, marketCondition: string): Promise<{strategy: string; parameters: any}> {
        try {
            const result = await this.promptAgent(`Generate a trading strategy for ${asset} in ${marketCondition} market conditions. Format your response as a JSON object with 'strategy' and 'parameters' keys.`);

            // Try to extract JSON from the response
            const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/) ||
                              result.match(/{[\s\S]*?}/);

            if (jsonMatch) {
                try {
                    const strategyData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                    return {
                        strategy: strategyData.strategy || "HOLD",
                        parameters: strategyData.parameters || {}
                    };
                } catch (e) {
                    // JSON parse failed
                    return { strategy: "HOLD", parameters: {} };
                }
            }

            return { strategy: "HOLD", parameters: {} };
        } catch (error) {
            elizaLogger.error(`Error generating trading strategy for ${asset}:`, error);
            return { strategy: "HOLD", parameters: {} };
        }
    }

    async analyzeTradingPerformance(tradeHistory: any[]): Promise<{insights: string; recommendations: string[]}> {
        try {
            // Convert trade history to a string representation
            const tradeHistoryStr = JSON.stringify(tradeHistory.slice(0, 20)); // Limit to avoid token limits

            const result = await this.promptAgent(`Analyze this trading history and provide insights and recommendations: ${tradeHistoryStr}. Format your response as a JSON object with 'insights' and 'recommendations' keys.`);

            // Try to extract JSON from the response
            const jsonMatch = result.match(/```json\s*([\s\S]*?)\s*```/) ||
                              result.match(/{[\s\S]*?}/);

            if (jsonMatch) {
                try {
                    const analysisData = JSON.parse(jsonMatch[1] || jsonMatch[0]);
                    return {
                        insights: analysisData.insights || "No insights available",
                        recommendations: analysisData.recommendations || []
                    };
                } catch (e) {
                    // JSON parse failed
                    return {
                        insights: result,
                        recommendations: []
                    };
                }
            }

            return {
                insights: result,
                recommendations: []
            };
        } catch (error) {
            elizaLogger.error(`Error analyzing trading performance:`, error);
            return { insights: "Error analyzing performance", recommendations: [] };
        }
    }

    // Helper method to prompt the agent using available runtime methods
    private async promptAgent(prompt: string): Promise<string> {
        try {
            // Create a fake user message to get a response from the agent
            const roomId = this.runtime.getSetting("DEFAULT_ROOM_ID") || uuidv4();
            const userId = this.runtime.getSetting("SERVICE_USER_ID") || uuidv4();

            // Create a memory object for the message
            const memory: Memory = {
                id: uuidv4() as UUID,
                roomId: roomId as UUID,
                userId: userId as UUID,
                agentId: this.runtime.agentId,
                content: {
                    type: "text",
                    text: prompt
                },
                embedding: null,
                createdAt: Date.now()
            };

            // Create a state for processing
            const state = await this.runtime.composeState(memory);

            // Process the message to get a response
            const responses: Memory[] = [];

            // Add a callback to collect responses
            await this.runtime.processActions(memory, responses, state, async () => {
                return responses;
            });

            // Extract the response text
            if (responses.length > 0 && responses[0].content.type === "text") {
                return responses[0].content.text;
            }

            return "No response received";
        } catch (error) {
            elizaLogger.error("Error prompting agent:", error);
            throw error;
        }
    }
}